// Withdrawals: money out to a bank account through the payment provider (ARCHITECTURE §8.4).
// The amount + fee is held first and committed; only then is the payout sent, so the provider
// can never pay out money Fundra has no record of. The provider's answer (applyEvent) settles
// the hold into a real posting, or releases it.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ErrorCode,
  ForbiddenError,
  isRetryable,
  NotFoundError,
  ServiceUnavailableError,
} from '../../common/errors/index.ts';
import type {
  IdempotencyService,
  IdempotentResult,
} from '../../common/idempotency/idempotency.service.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import { success } from '../../common/utils/response.ts';
import type { Payment, Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import {
  checkOutflow,
  findTierLimits,
  outflowLimitError,
  outflowToday,
} from '../kyc/tier-limits.ts';
import { placeHold, releaseHold, settleHold } from '../ledger/holds.ts';
import { lockTransactionRow } from '../ledger/ledger.repository.ts';
import { lockWallets } from '../ledger/ledger.service.ts';
import { feeRevenueAccountCode, providerSettlementAccountCode } from '../ledger/ledger.utils.ts';
import { feeFor } from '../transactions/fees.ts';
import {
  createTransaction,
  transactionViewFor,
  transitionTransaction,
} from '../transactions/transaction.service.ts';
import {
  holdForReview,
  jsonObject,
  recordProviderStatus,
  type PaymentEvent,
  type PaymentEventOutcome,
  type PaymentReviewReason,
} from './payment-review.ts';
import type { BankAccountQuery, CreateWithdrawalInput } from './payment.schema.ts';
import type { PaymentProvider, ResolvedBankAccount } from './providers/payment-provider.ts';

type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;

/** What sending the payout did. Anything but SENT or FAILED leaves the hold for a retry. */
export type DispatchOutcome = 'SENT' | 'FAILED' | 'NOT_SENT' | 'SKIPPED';

const unavailable = (cause: unknown) =>
  new ServiceUnavailableError(
    'Withdrawals are temporarily unavailable. Nothing was taken; try again shortly.',
    { cause, retryAfterSeconds: 30 },
  );

const bankAccountNotFound = () =>
  new NotFoundError('No bank account matches that bank and account number.', {
    code: ErrorCode.BANK_ACCOUNT_NOT_FOUND,
  });

/** `0123456789` → `******6789`: enough to recognise, not enough to reuse. */
export function maskAccountNumber(accountNumber: string): string {
  return `${'*'.repeat(Math.max(accountNumber.length - 4, 0))}${accountNumber.slice(-4)}`;
}

export class WithdrawalService {
  readonly #db: PrismaClient;
  readonly #provider: PaymentProvider;
  readonly #idempotency: IdempotencyService;
  readonly #now: () => number;

  constructor(
    db: PrismaClient,
    provider: PaymentProvider,
    idempotency: IdempotencyService,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#provider = provider;
    this.#idempotency = idempotency;
    this.#now = now;
  }

  /** Name enquiry: who the bank says owns the account, so the customer can confirm. */
  async resolveBankAccount(query: BankAccountQuery): Promise<ResolvedBankAccount> {
    const account = await this.#resolve(query);
    if (account === null) throw bankAccountNotFound();
    return account;
  }

  /**
   * Withdraws, at most once per Idempotency-Key. Two steps, deliberately: (1) inside the
   * idempotency transaction, the amount + fee is held and the withdrawal committed as
   * PROCESSING; (2) after COMMIT, the payout is sent. The response is the committed state;
   * the outcome arrives in history. If the payout can't be sent now, the money stays held
   * and `dispatch` is retried later (it's idempotent: the provider dedupes our reference).
   */
  async create(
    userId: string,
    input: CreateWithdrawalInput,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
  ): Promise<IdempotentResult> {
    let created: string | undefined;
    let result: IdempotentResult;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await this.#idempotency.run(
          { userId, key: idempotency.key, fingerprint: idempotency.fingerprint },
          async (tx) => {
            const { transactionId, destination } = await this.#reserve(tx, userId, input, context);
            const withdrawal = await transactionViewFor(tx, userId, transactionId);
            created = transactionId;
            return { status: 201, body: success({ withdrawal, destination }), transactionId };
          },
        );
        break;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
    // Only the request that created it sends it; a replay never sends again.
    if (!result.replayed && created !== undefined) await this.dispatch(created);
    return result;
  }

  async #reserve(
    tx: Tx,
    userId: string,
    input: CreateWithdrawalInput,
    context: AuditContext,
  ): Promise<{
    transactionId: string;
    destination: { bankCode: string; accountNumber: string; accountName: string };
  }> {
    const now = this.#now();
    const currency: Currency = input.currency;

    const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
    const profile = await tx.kycProfile.findUnique({ where: { userId }, select: { tier: true } });
    const limits = wallet === null ? null : await findTierLimits(tx, profile?.tier ?? 0, currency);
    if (wallet === null || limits === null) {
      throw new ForbiddenError('Complete KYC Tier 1 to get a wallet before withdrawing.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }
    const provider = await tx.paymentProvider.findUnique({ where: { code: this.#provider.code } });
    if (provider?.isActive !== true) {
      throw unavailable(new Error(`Payment provider ${this.#provider.code} is not active`));
    }
    // The name comes from the bank, never from the client. Asked before any lock is taken.
    const account = await this.#resolve(input);
    if (account === null) throw bankAccountNotFound();
    const fee = await feeFor(tx, 'WITHDRAWAL', input.amount, currency, now);

    // Limits against the locked wallet, as for transfers; placeHold re-checks status and funds.
    await lockWallets(tx, [wallet.id]);
    const outflow = checkOutflow({
      limits,
      amount: input.amount,
      fee,
      outflowToday: await outflowToday(tx, wallet.id, now),
    });
    if (outflow !== null) throw outflowLimitError(outflow, currency);

    const transaction = await createTransaction(
      tx,
      {
        type: 'WITHDRAWAL',
        currency,
        amount: input.amount,
        fee,
        sourceWalletId: wallet.id,
        initiatedByUserId: userId,
        description: input.description ?? null,
      },
      now,
    );
    await placeHold(tx, {
      transactionId: transaction.id,
      walletId: wallet.id,
      amount: input.amount + fee,
    });
    await tx.payment.create({
      data: {
        transactionId: transaction.id,
        providerId: provider.id,
        direction: 'OUTBOUND',
        providerStatus: 'queued',
        bankCode: account.bankCode,
        bankAccountNumber: account.accountNumber,
        bankAccountName: account.accountName,
      },
    });
    await transitionTransaction(tx, transaction.id, 'PROCESSING', { now });

    await recordAudit(tx, {
      action: 'withdrawal.requested',
      actor: { type: 'USER', userId },
      resource: { type: 'transaction', id: transaction.id },
      context,
      metadata: {
        reference: transaction.reference,
        amount: input.amount.toString(),
        fee: fee.toString(),
        currency,
        bankCode: account.bankCode,
        accountNumber: maskAccountNumber(account.accountNumber),
      },
    });
    return {
      transactionId: transaction.id,
      destination: {
        bankCode: account.bankCode,
        accountNumber: maskAccountNumber(account.accountNumber),
        accountName: account.accountName,
      },
    };
  }

  /**
   * Sends a held withdrawal's payout. Safe to call again (a retry job, after a crash or an
   * outage): it acts only on a PROCESSING withdrawal not yet sent, and the provider returns
   * the same payout for the same reference. Never throws: a payout that can't be sent now
   * stays held, with the reason on the payment, for the next attempt.
   */
  async dispatch(transactionId: string): Promise<DispatchOutcome> {
    const payment = await this.#db.payment.findUnique({
      where: { transactionId },
      include: { transaction: true },
    });
    if (
      payment?.direction !== 'OUTBOUND' ||
      payment.transaction.type !== 'WITHDRAWAL' ||
      payment.transaction.status !== 'PROCESSING' ||
      payment.providerReference !== null ||
      payment.bankCode === null ||
      payment.bankAccountNumber === null ||
      payment.bankAccountName === null
    ) {
      return 'SKIPPED';
    }
    const { transaction } = payment;

    let result;
    try {
      result = await this.#provider.sendPayout({
        reference: transaction.reference,
        amount: transaction.amount,
        currency: transaction.currency as Currency,
        destination: {
          bankCode: payment.bankCode,
          accountNumber: payment.bankAccountNumber,
          accountName: payment.bankAccountName,
        },
        narration: transaction.description ?? `Fundra ${transaction.reference}`,
      });
    } catch (err) {
      // Unknown whether the provider took it: keep the hold; the retry asks again by reference.
      await this.#db.payment.update({
        where: { transactionId },
        data: {
          providerStatus: 'dispatch_failed',
          metadata: { ...jsonObject(payment.metadata), dispatchError: errorMessage(err) },
        },
      });
      return 'NOT_SENT';
    }

    if (result.status === 'PENDING') {
      // Only if still unset: the webhook may already have arrived and attached it.
      await this.#db.payment.updateMany({
        where: { transactionId, providerReference: null },
        data: { providerReference: result.providerReference, providerStatus: 'pending' },
      });
      return 'SENT';
    }
    const reason = result.reason;
    await this.#db.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { transactionId, providerReference: null },
        data: { providerReference: result.providerReference, providerStatus: 'rejected' },
      });
      await this.#fail(tx, transactionId, reason, null);
    });
    return 'FAILED';
  }

  /**
   * Applies a verified provider event for a payout, exactly once (the transaction row is
   * locked first). Success settles the hold into the real posting; failure releases it.
   */
  async applyEvent(event: PaymentEvent): Promise<PaymentEventOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#db.$transaction((tx) => this.#apply(tx, event));
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  async #apply(tx: Tx, event: PaymentEvent): Promise<PaymentEventOutcome> {
    const provider = await tx.paymentProvider.findUniqueOrThrow({
      where: { code: this.#provider.code },
      select: { id: true, code: true },
    });
    const payment = await this.#findPayment(tx, provider.id, event);
    if (payment === null) return { outcome: 'UNMATCHED' };

    await lockTransactionRow(tx, payment.transactionId);
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: payment.transactionId },
      include: { sourceWallet: { select: { userId: true, ledgerAccountId: true } } },
    });
    const wallet = transaction.sourceWallet;
    const review = (reason: PaymentReviewReason) =>
      holdForReview(tx, {
        transactionId: transaction.id,
        reference: transaction.reference,
        event,
        reason,
        now: this.#now(),
      });

    if (
      event.kind !== 'PAYOUT' ||
      transaction.type !== 'WITHDRAWAL' ||
      payment.direction !== 'OUTBOUND' ||
      wallet === null
    ) {
      return review('WRONG_KIND');
    }
    if (transaction.status === 'COMPLETED' || transaction.status === 'REVERSED') {
      return event.outcome === 'SUCCEEDED'
        ? { outcome: 'ALREADY_APPLIED', transactionId: transaction.id }
        : review('FAILURE_AFTER_SUCCESS');
    }
    if (transaction.status === 'FAILED' || transaction.status === 'CANCELLED') {
      // A success here means money left after the hold was released: a person must recover it.
      return event.outcome === 'FAILED'
        ? { outcome: 'ALREADY_APPLIED', transactionId: transaction.id }
        : review('SUCCESS_AFTER_FAILURE');
    }
    if (event.reference !== transaction.reference) return review('REFERENCE_MISMATCH');
    if (event.currency !== transaction.currency) return review('CURRENCY_MISMATCH');
    // The payout is the amount; the fee never leaves Fundra.
    if (event.amount !== transaction.amount) return review('AMOUNT_MISMATCH');

    if (event.outcome === 'FAILED') {
      await recordProviderStatus(tx, transaction.id, event);
      await this.#fail(
        tx,
        transaction.id,
        event.reason ?? 'The bank did not accept the transfer.',
        event.eventId,
      );
      return { outcome: 'FAILED', transactionId: transaction.id };
    }

    const currency = event.currency;
    const settlement = await tx.ledgerAccount.findUniqueOrThrow({
      where: { code: providerSettlementAccountCode(provider.code, currency) },
      select: { id: true },
    });
    const entries = [
      {
        ledgerAccountId: wallet.ledgerAccountId,
        direction: 'DEBIT' as const,
        amount: transaction.amount + transaction.fee,
      },
      { ledgerAccountId: settlement.id, direction: 'CREDIT' as const, amount: transaction.amount },
    ];
    if (transaction.fee > 0n) {
      const revenue = await tx.ledgerAccount.findUniqueOrThrow({
        where: { code: feeRevenueAccountCode(currency) },
        select: { id: true },
      });
      entries.push({ ledgerAccountId: revenue.id, direction: 'CREDIT', amount: transaction.fee });
    }
    // Settles even if the wallet was frozen since: the money has really left.
    await settleHold(tx, { transactionId: transaction.id, entries });
    await transitionTransaction(tx, transaction.id, 'COMPLETED', { now: this.#now() });
    await recordProviderStatus(tx, transaction.id, event);
    await recordAudit(tx, {
      action: 'withdrawal.completed',
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: transaction.id },
      metadata: {
        reference: transaction.reference,
        eventId: event.eventId,
        amount: transaction.amount.toString(),
        fee: transaction.fee.toString(),
        currency,
        provider: provider.code,
      },
    });
    await writeOutboxEvent(tx, {
      type: 'withdrawal.completed',
      aggregate: { type: 'transaction', id: transaction.id },
      payload: {
        transactionId: transaction.id,
        reference: transaction.reference,
        userId: wallet.userId,
        amount: transaction.amount.toString(),
        fee: transaction.fee.toString(),
        currency,
      },
    });
    return { outcome: 'COMPLETED', transactionId: transaction.id };
  }

  /**
   * By provider reference; failing that, by our own reference for a payout whose provider
   * reference isn't stored yet (the webhook beat dispatch's update), which it then attaches.
   */
  async #findPayment(tx: Tx, providerId: string, event: PaymentEvent): Promise<Payment | null> {
    const byProvider = await tx.payment.findUnique({
      where: {
        providerId_providerReference: { providerId, providerReference: event.providerReference },
      },
    });
    if (byProvider !== null) return byProvider;
    const transaction = await tx.transaction.findUnique({
      where: { reference: event.reference },
      select: { payment: true },
    });
    const payment = transaction?.payment ?? null;
    if (payment?.providerId !== providerId || payment.providerReference !== null) return null;
    return tx.payment.update({
      where: { transactionId: payment.transactionId },
      data: { providerReference: event.providerReference },
    });
  }

  /** Releases the hold and marks the withdrawal FAILED (if it's still in flight). */
  async #fail(
    tx: Tx,
    transactionId: string,
    reason: string,
    eventId: string | null,
  ): Promise<void> {
    await lockTransactionRow(tx, transactionId);
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      include: { sourceWallet: { select: { userId: true } } },
    });
    if (transaction.status !== 'PROCESSING' || transaction.sourceWallet === null) return;
    await releaseHold(tx, { transactionId });
    await transitionTransaction(tx, transactionId, 'FAILED', {
      failureReason: reason,
      now: this.#now(),
    });
    await recordAudit(tx, {
      action: 'withdrawal.failed',
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: transactionId },
      metadata: { reference: transaction.reference, eventId, reason },
    });
    await writeOutboxEvent(tx, {
      type: 'withdrawal.failed',
      aggregate: { type: 'transaction', id: transactionId },
      payload: {
        transactionId,
        reference: transaction.reference,
        userId: transaction.sourceWallet.userId,
        reason,
      },
    });
  }

  /** Name enquiry; an outage surfaces as 503, never as "no such account". */
  async #resolve(account: BankAccountQuery): Promise<ResolvedBankAccount | null> {
    try {
      return await this.#provider.resolveBankAccount({
        bankCode: account.bankCode,
        accountNumber: account.accountNumber,
      });
    } catch (err) {
      throw unavailable(err);
    }
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
