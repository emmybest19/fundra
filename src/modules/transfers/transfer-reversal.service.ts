// Reversing a completed transfer (admin action; `transactions:reverse`, endpoint in Stage 19).
// The sender gets everything back: the amount from the recipient (a REVERSAL linked to the
// original) and, if a fee was charged, the fee from FEE_REVENUE (a separate REFUND). Two
// records keep each party's history true: the recipient sees only what they returned.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  isRetryable,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import type {
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import { LedgerRefusal, post } from '../ledger/ledger.service.ts';
import { feeRevenueAccountCode } from '../ledger/ledger.utils.ts';
import { createTransaction, transitionTransaction } from '../transactions/transaction.service.ts';

type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;
const REASON_MAX_LENGTH = 500;

export interface ReversalResult {
  originalTransactionId: string;
  reversalTransactionId: string;
  feeRefundTransactionId: string | null;
}

interface LockedOriginal {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  currency: string;
  amount: bigint;
  fee: bigint;
  sourceWalletId: string | null;
  destinationWalletId: string | null;
}

export class TransferReversalService {
  readonly #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  /**
   * Undoes a COMPLETED transfer in one database transaction: the original row is locked
   * first, so two reversals can't race. Reversals skip tier limits and pass frozen wallets
   * (the ledger exempts REVERSAL and REFUND), but never overdraw: if the recipient has
   * spent the money, nothing changes and the admin decides what's next.
   */
  async reverse(
    transactionId: string,
    adminId: string,
    reason: string,
    context: AuditContext,
  ): Promise<ReversalResult> {
    const why = reason.trim();
    if (why.length === 0 || why.length > REASON_MAX_LENGTH) {
      throw new ValidationError([
        { path: 'reason', message: `Give a reason of 1–${String(REASON_MAX_LENGTH)} characters` },
      ]);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#db.$transaction((tx) =>
          this.#reverse(tx, transactionId, adminId, why, context),
        );
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  async #reverse(
    tx: Tx,
    transactionId: string,
    adminId: string,
    reason: string,
    context: AuditContext,
  ): Promise<ReversalResult> {
    const [original] = await tx.$queryRaw<LockedOriginal[]>`
      SELECT id, reference, type, status, currency, amount, fee,
             source_wallet_id AS "sourceWalletId", destination_wallet_id AS "destinationWalletId"
      FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
    if (original === undefined) throw new NotFoundError('Transaction not found.');
    if (original.type !== 'TRANSFER') {
      throw new ConflictError('Only transfers can be reversed here.', {
        code: ErrorCode.TRANSACTION_NOT_REVERSIBLE,
      });
    }
    if (original.status !== 'COMPLETED') {
      throw new ConflictError(
        original.status === 'REVERSED'
          ? 'This transfer has already been reversed.'
          : `A ${original.status} transfer moved no money, so there is nothing to reverse.`,
        { code: ErrorCode.TRANSACTION_NOT_REVERSIBLE },
      );
    }
    if (original.sourceWalletId === null || original.destinationWalletId === null) {
      throw new Error(`Transfer ${original.id} is missing a wallet`);
    }

    const wallets = await tx.wallet.findMany({
      where: { id: { in: [original.sourceWalletId, original.destinationWalletId] } },
      select: { id: true, userId: true, ledgerAccountId: true },
    });
    const sender = wallets.find((w) => w.id === original.sourceWalletId);
    const recipient = wallets.find((w) => w.id === original.destinationWalletId);
    if (sender === undefined || recipient === undefined) {
      throw new Error(`Transfer ${original.id} points at a missing wallet`);
    }
    // Separation of duties: nobody reverses money into or out of their own wallet.
    if (sender.userId === adminId || recipient.userId === adminId) {
      throw new ForbiddenError("You can't reverse a transaction involving your own wallet.", {
        code: ErrorCode.TRANSACTION_SELF_ACTION,
      });
    }
    const currency = original.currency as Currency;

    // 1. The amount, back from the recipient.
    const reversal = await createTransaction(tx, {
      type: 'REVERSAL',
      currency,
      amount: original.amount,
      sourceWalletId: recipient.id,
      destinationWalletId: sender.id,
      reversalOfId: original.id,
      initiatedByUserId: adminId,
      metadata: { kind: 'ADMIN_REVERSAL' },
    });
    try {
      await post(tx, {
        transactionId: reversal.id,
        entries: [
          {
            ledgerAccountId: recipient.ledgerAccountId,
            direction: 'DEBIT',
            amount: original.amount,
          },
          { ledgerAccountId: sender.ledgerAccountId, direction: 'CREDIT', amount: original.amount },
        ],
      });
    } catch (err) {
      if (err instanceof LedgerRefusal && err.code === 'INSUFFICIENT_FUNDS') {
        throw new UnprocessableError(
          "The recipient's available balance can't cover this reversal. Nothing was changed.",
          { code: ErrorCode.INSUFFICIENT_FUNDS, cause: err },
        );
      }
      throw err;
    }
    await transitionTransaction(tx, reversal.id, 'COMPLETED');

    // 2. The fee, back from revenue (only if one was charged).
    let feeRefundId: string | null = null;
    if (original.fee > 0n) {
      const refund = await createTransaction(tx, {
        type: 'REFUND',
        currency,
        amount: original.fee,
        destinationWalletId: sender.id,
        initiatedByUserId: adminId,
        metadata: { kind: 'FEE_REFUND', refundOf: original.id },
      });
      const revenue = await tx.ledgerAccount.findUniqueOrThrow({
        where: { code: feeRevenueAccountCode(currency) },
        select: { id: true },
      });
      await post(tx, {
        transactionId: refund.id,
        entries: [
          { ledgerAccountId: revenue.id, direction: 'DEBIT', amount: original.fee },
          { ledgerAccountId: sender.ledgerAccountId, direction: 'CREDIT', amount: original.fee },
        ],
      });
      await transitionTransaction(tx, refund.id, 'COMPLETED');
      feeRefundId = refund.id;
    }

    // 3. The original is now REVERSED (needs the COMPLETED reversal above).
    await transitionTransaction(tx, original.id, 'REVERSED');

    await recordAudit(tx, {
      action: 'transaction.reversed',
      actor: { type: 'ADMIN', userId: adminId },
      resource: { type: 'transaction', id: original.id },
      context,
      metadata: {
        reference: original.reference,
        reversalTransactionId: reversal.id,
        feeRefundTransactionId: feeRefundId,
        amount: original.amount.toString(),
        fee: original.fee.toString(),
        currency,
        reason,
      },
    });
    await writeOutboxEvent(tx, {
      type: 'transaction.reversed',
      aggregate: { type: 'transaction', id: original.id },
      payload: {
        originalTransactionId: original.id,
        reversalTransactionId: reversal.id,
        feeRefundTransactionId: feeRefundId,
        reference: original.reference,
        senderUserId: sender.userId,
        recipientUserId: recipient.userId,
        amount: original.amount.toString(),
        fee: original.fee.toString(),
        currency,
      },
    });
    return {
      originalTransactionId: original.id,
      reversalTransactionId: reversal.id,
      feeRefundTransactionId: feeRefundId,
    };
  }
}
