// Business logic for transfers: P2P money movement between Fundra wallets
// (docs/ARCHITECTURE.md §8.1). Everything runs in one database transaction inside the
// idempotency service, so a retried request replays the original answer and never moves
// money twice.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ErrorCode,
  ForbiddenError,
  isRetryable,
  NotFoundError,
  UnprocessableError,
} from '../../common/errors/index.ts';
import type {
  IdempotencyService,
  IdempotentResult,
} from '../../common/idempotency/idempotency.service.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import { lagosDayBounds } from '../../common/utils/business-day.ts';
import { success } from '../../common/utils/response.ts';
import type { Prisma, PrismaClient, Wallet } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import {
  checkInflow,
  checkOutflow,
  findTierLimits,
  inflowLimitError,
  OUTFLOW_COUNTED_STATUSES,
  OUTFLOW_TYPES,
  outflowLimitError,
} from '../kyc/tier-limits.ts';
import { LedgerRefusal, lockWallets, post } from '../ledger/ledger.service.ts';
import { feeRevenueAccountCode } from '../ledger/ledger.utils.ts';
import {
  createTransaction,
  transactionViewFor,
  transitionTransaction,
} from '../transactions/transaction.service.ts';
import type { CreateTransferInput, RecipientQuery } from './transfer.schema.ts';
import { computeFee, type RecipientView } from './transfer.types.ts';

type Tx = Prisma.TransactionClient;

/** Deadlocks, serialization failures, lock timeouts: rolled back, so safe to run again. */
const MAX_ATTEMPTS = 3;

type RecipientWallet = Wallet & {
  user: { status: string; handle: string; firstName: string; lastName: string };
};

const recipientCannotReceive = () =>
  new UnprocessableError("The recipient can't receive this amount right now.", {
    code: ErrorCode.RECIPIENT_CANNOT_RECEIVE,
  });

export class TransferService {
  readonly #db: PrismaClient;
  readonly #idempotency: IdempotencyService;
  readonly #now: () => number;

  constructor(db: PrismaClient, idempotency: IdempotencyService, now: () => number = Date.now) {
    this.#db = db;
    this.#idempotency = idempotency;
    this.#now = now;
  }

  /**
   * D2: who an account number or handle belongs to, so the sender can confirm before
   * sending. Only the public name and handle; closed wallets and disabled accounts look like
   * nobody. Rate limited by the route against enumeration.
   */
  async lookupRecipient(query: RecipientQuery): Promise<RecipientView> {
    const wallet = await this.#findRecipient(this.#db, query.currency, {
      ...(query.handle === undefined ? {} : { handle: query.handle }),
      ...(query.accountNumber === undefined ? {} : { accountNumber: query.accountNumber }),
    });
    return {
      name: `${wallet.user.firstName} ${wallet.user.lastName}`,
      handle: wallet.user.handle,
    };
  }

  /**
   * Sends money, at most once per Idempotency-Key. A refusal (funds, limits, recipient)
   * moves nothing and releases the key, so the same request can be retried. A deadlock or
   * lock timeout is retried here, up to MAX_ATTEMPTS.
   */
  async create(
    senderId: string,
    input: CreateTransferInput,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
  ): Promise<IdempotentResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#idempotency.run(
          { userId: senderId, key: idempotency.key, fingerprint: idempotency.fingerprint },
          async (tx) => {
            const transactionId = await this.#transfer(tx, senderId, input, context);
            const transfer = await transactionViewFor(tx, senderId, transactionId);
            return { status: 201, body: success({ transfer }), transactionId };
          },
        );
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  /** The money movement itself, inside the idempotency transaction. Returns the transaction ID. */
  async #transfer(
    tx: Tx,
    senderId: string,
    input: CreateTransferInput,
    context: AuditContext,
  ): Promise<string> {
    const now = this.#now();
    const currency: Currency = input.currency;

    const sender = await tx.wallet.findUnique({
      where: { userId_currency: { userId: senderId, currency } },
    });
    if (sender === null) {
      throw new ForbiddenError('Complete KYC Tier 1 to get a wallet before sending money.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }
    const recipient = await this.#findRecipient(tx, currency, {
      ...(input.recipientHandle === undefined ? {} : { handle: input.recipientHandle }),
      ...(input.recipientAccountNumber === undefined
        ? {}
        : { accountNumber: input.recipientAccountNumber }),
    });
    if (recipient.id === sender.id) {
      throw new UnprocessableError("You can't send money to yourself.", {
        code: ErrorCode.SELF_TRANSFER,
      });
    }

    const fee = await this.#fee(tx, input.amount, currency, now);
    // One at a time: a transaction's queries share one connection (pg@9 will reject overlap).
    const senderTier = await this.#tier(tx, senderId);
    const recipientTier = await this.#tier(tx, recipient.userId);
    const senderLimits = await findTierLimits(tx, senderTier, currency);
    if (senderLimits === null) {
      throw new ForbiddenError('Complete KYC Tier 1 before sending money.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }

    // Limits are checked against locked balances: post() takes the same locks again (no-op),
    // and summing today's outflow under the sender's lock stops two parallel sends from
    // jointly slipping past the daily limit.
    const locked = new Map(
      (await lockWallets(tx, [sender.id, recipient.id])).map((w) => [w.id, w]),
    );
    const outflowToday = await this.#outflowToday(tx, sender.id, now);
    const outflow = checkOutflow({ limits: senderLimits, amount: input.amount, fee, outflowToday });
    if (outflow !== null) throw outflowLimitError(outflow, currency);
    const recipientLimits = await findTierLimits(tx, recipientTier, currency);
    const lockedRecipient = locked.get(recipient.id);
    if (recipientLimits === null || lockedRecipient === undefined) throw recipientCannotReceive();
    const inflow = checkInflow({
      limits: recipientLimits,
      kind: 'TRANSFER_IN',
      balanceAfter: lockedRecipient.ledgerBalance + input.amount,
    });
    if (inflow !== null) throw inflowLimitError(inflow, currency, 'OTHER');

    const transaction = await createTransaction(
      tx,
      {
        type: 'TRANSFER',
        currency,
        amount: input.amount,
        fee,
        sourceWalletId: sender.id,
        destinationWalletId: recipient.id,
        initiatedByUserId: senderId,
        description: input.description ?? null,
      },
      now,
    );
    await tx.transfer.create({
      data: {
        transactionId: transaction.id,
        recipientLookup: input.recipientHandle === undefined ? 'ACCOUNT_NUMBER' : 'HANDLE',
        recipientLookupValue: input.recipientHandle ?? input.recipientAccountNumber ?? '',
      },
    });

    const entries = [
      {
        ledgerAccountId: sender.ledgerAccountId,
        direction: 'DEBIT' as const,
        amount: input.amount + fee,
      },
      {
        ledgerAccountId: recipient.ledgerAccountId,
        direction: 'CREDIT' as const,
        amount: input.amount,
      },
    ];
    if (fee > 0n) {
      const revenue = await tx.ledgerAccount.findUniqueOrThrow({
        where: { code: feeRevenueAccountCode(currency) },
        select: { id: true },
      });
      entries.push({ ledgerAccountId: revenue.id, direction: 'CREDIT', amount: fee });
    }
    try {
      await post(tx, { transactionId: transaction.id, entries });
    } catch (err) {
      // The recipient's wallet refused (frozen, closed): the sender learns nothing about why.
      if (err instanceof LedgerRefusal && err.walletId === recipient.id)
        throw recipientCannotReceive();
      throw err;
    }
    await transitionTransaction(tx, transaction.id, 'COMPLETED', { now });

    await recordAudit(tx, {
      action: 'transfer.completed',
      actor: { type: 'USER', userId: senderId },
      resource: { type: 'transaction', id: transaction.id },
      context,
      metadata: {
        reference: transaction.reference,
        amount: input.amount.toString(),
        fee: fee.toString(),
        currency,
        recipientUserId: recipient.userId,
        recipientLookup: input.recipientHandle === undefined ? 'ACCOUNT_NUMBER' : 'HANDLE',
      },
    });
    await writeOutboxEvent(tx, {
      type: 'transfer.completed',
      aggregate: { type: 'transaction', id: transaction.id },
      payload: {
        transactionId: transaction.id,
        reference: transaction.reference,
        senderUserId: senderId,
        recipientUserId: recipient.userId,
        amount: input.amount.toString(),
        fee: fee.toString(),
        currency,
      },
    });
    return transaction.id;
  }

  /** A wallet that can receive: its owner not suspended or deactivated, the wallet not CLOSED. */
  async #findRecipient(
    db: Pick<Tx, 'wallet' | 'user'>,
    currency: Currency,
    by: { handle?: string; accountNumber?: string },
  ): Promise<RecipientWallet> {
    const include = {
      user: { select: { status: true, handle: true, firstName: true, lastName: true } },
    } as const;
    const wallet =
      by.accountNumber !== undefined
        ? await db.wallet.findUnique({ where: { accountNumber: by.accountNumber }, include })
        : await db.wallet.findFirst({
            where: { currency, user: { handle: by.handle ?? '' } },
            include,
          });
    if (
      wallet?.currency !== currency ||
      wallet.status === 'CLOSED' ||
      wallet.user.status === 'SUSPENDED' ||
      wallet.user.status === 'DEACTIVATED'
    ) {
      throw new NotFoundError('No Fundra wallet matches that recipient.', {
        code: ErrorCode.RECIPIENT_NOT_FOUND,
      });
    }
    return wallet;
  }

  /** The active TRANSFER fee rule; a missing rule fails closed (a configuration error). */
  async #fee(tx: Tx, amount: bigint, currency: Currency, now: number): Promise<bigint> {
    const rule = await tx.feeRule.findFirst({
      where: {
        transactionType: 'TRANSFER',
        currency,
        isActive: true,
        effectiveFrom: { lte: new Date(now) },
      },
    });
    if (rule === null) throw new Error(`No active TRANSFER fee rule for ${currency}`);
    return computeFee(amount, rule);
  }

  async #tier(tx: Tx, userId: string): Promise<number> {
    const profile = await tx.kycProfile.findUnique({ where: { userId }, select: { tier: true } });
    return profile?.tier ?? 0;
  }

  /** amount + fee of the wallet's outflows today (Lagos day) that count toward the limit. */
  async #outflowToday(tx: Tx, walletId: string, now: number): Promise<bigint> {
    const { start, end } = lagosDayBounds(now);
    const sum = await tx.transaction.aggregate({
      where: {
        sourceWalletId: walletId,
        type: { in: [...OUTFLOW_TYPES] },
        status: { in: [...OUTFLOW_COUNTED_STATUSES] },
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true, fee: true },
    });
    return (sum._sum.amount ?? 0n) + (sum._sum.fee ?? 0n);
  }
}
