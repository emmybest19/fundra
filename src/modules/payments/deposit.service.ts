// Deposits: money in from outside through the payment provider (docs/ARCHITECTURE.md §8.3).
// Starting one creates a PROCESSING transaction and a checkout URL; only the provider's
// webhook (applyEvent, called by the webhook processor) decides the outcome, never the
// customer's redirect. Anything the processor can't trust is held for review, not credited.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ErrorCode,
  ForbiddenError,
  isRetryable,
  ServiceUnavailableError,
} from '../../common/errors/index.ts';
import type {
  IdempotencyService,
  IdempotentResult,
} from '../../common/idempotency/idempotency.service.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import { success } from '../../common/utils/response.ts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import { checkInflow, findTierLimits, inflowLimitError } from '../kyc/tier-limits.ts';
import { lockTransactionRow } from '../ledger/ledger.repository.ts';
import { LedgerRefusal, lockWallets, post } from '../ledger/ledger.service.ts';
import { providerSettlementAccountCode, walletStatusRefusal } from '../ledger/ledger.utils.ts';
import {
  createTransaction,
  transactionViewFor,
  transitionTransaction,
} from '../transactions/transaction.service.ts';
import type { CreateDepositInput } from './payment.schema.ts';
import {
  PaymentProviderUnavailableError,
  type PaymentProvider,
  type ProviderEvent,
} from './providers/payment-provider.ts';

type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;

export type DepositEvent = Extract<ProviderEvent, { kind: 'DEPOSIT' | 'PAYOUT' }>;

/** Why a deposit event was held instead of applied. Each needs a person to look at it. */
export type DepositReviewReason =
  | 'NOT_A_DEPOSIT'
  | 'REFERENCE_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  /** Success reported for a deposit Fundra already marked FAILED: money may have arrived. */
  | 'SUCCESS_AFTER_FAILURE'
  /** Failure reported for a deposit already credited. */
  | 'FAILURE_AFTER_SUCCESS'
  | 'WALLET_FROZEN'
  | 'WALLET_CLOSED'
  | 'MAX_BALANCE';

/** What applying a provider event did; the webhook processor records it on the event. */
export type DepositEventOutcome =
  | { outcome: 'COMPLETED' | 'FAILED'; transactionId: string }
  /** The deposit already had this outcome: a re-notification, nothing to do. */
  | { outcome: 'ALREADY_APPLIED'; transactionId: string }
  | { outcome: 'REVIEW'; transactionId: string; reason: DepositReviewReason }
  /** No deposit has this provider reference. */
  | { outcome: 'UNMATCHED' };

const unavailable = (cause: unknown) =>
  new ServiceUnavailableError(
    'Deposits are temporarily unavailable. Nothing was charged; try again shortly.',
    { cause, retryAfterSeconds: 30 },
  );

export class DepositService {
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

  /**
   * Opens a deposit, at most once per Idempotency-Key. The provider is called inside the
   * idempotency transaction, after the transaction row exists (so its reference is ours and
   * unique) and before COMMIT: if the provider is down, or COMMIT fails, nothing is kept and
   * the key is released. A provider session left behind by a failed COMMIT is harmless: its
   * checkout URL never reached the customer. No row locks are held during the call.
   */
  async create(
    userId: string,
    input: CreateDepositInput,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
  ): Promise<IdempotentResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#idempotency.run(
          { userId, key: idempotency.key, fingerprint: idempotency.fingerprint },
          async (tx) => {
            const { transactionId, checkoutUrl } = await this.#open(tx, userId, input, context);
            const deposit = await transactionViewFor(tx, userId, transactionId);
            return { status: 201, body: success({ deposit, checkoutUrl }), transactionId };
          },
        );
      } catch (err) {
        if (err instanceof PaymentProviderUnavailableError) throw unavailable(err);
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  async #open(
    tx: Tx,
    userId: string,
    input: CreateDepositInput,
    context: AuditContext,
  ): Promise<{ transactionId: string; checkoutUrl: string }> {
    const now = this.#now();
    const currency: Currency = input.currency;

    const wallet = await tx.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
      include: { user: { select: { email: true } } },
    });
    const profile = await tx.kycProfile.findUnique({ where: { userId }, select: { tier: true } });
    const limits = wallet === null ? null : await findTierLimits(tx, profile?.tier ?? 0, currency);
    if (wallet === null || limits === null) {
      throw new ForbiddenError('Complete KYC Tier 1 to get a wallet before adding money.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }
    const refusal = walletStatusRefusal(wallet.status, 'DEPOSIT');
    if (refusal !== null) throw new LedgerRefusal(refusal, wallet.id);
    // An early answer only: other deposits may land first, so completion checks again.
    const inflow = checkInflow({
      limits,
      kind: 'DEPOSIT',
      balanceAfter: wallet.ledgerBalance + input.amount,
    });
    if (inflow !== null) throw inflowLimitError(inflow, currency, 'SELF');

    const provider = await tx.paymentProvider.findUnique({ where: { code: this.#provider.code } });
    if (provider?.isActive !== true) {
      throw unavailable(new Error(`Payment provider ${this.#provider.code} is not active`));
    }

    const transaction = await createTransaction(
      tx,
      {
        type: 'DEPOSIT',
        currency,
        amount: input.amount,
        destinationWalletId: wallet.id,
        initiatedByUserId: userId,
      },
      now,
    );
    const session = await this.#provider.initializeDeposit({
      reference: transaction.reference,
      amount: input.amount,
      currency,
      email: wallet.user.email,
    });
    await tx.payment.create({
      data: {
        transactionId: transaction.id,
        providerId: provider.id,
        direction: 'INBOUND',
        providerReference: session.providerReference,
        providerStatus: 'initialized',
        checkoutUrl: session.checkoutUrl,
      },
    });
    // Waiting on the customer and the provider now.
    await transitionTransaction(tx, transaction.id, 'PROCESSING', { now });

    await recordAudit(tx, {
      action: 'deposit.initiated',
      actor: { type: 'USER', userId },
      resource: { type: 'transaction', id: transaction.id },
      context,
      metadata: {
        reference: transaction.reference,
        amount: input.amount.toString(),
        currency,
        provider: this.#provider.code,
      },
    });
    return { transactionId: transaction.id, checkoutUrl: session.checkoutUrl };
  }

  /**
   * Applies a verified provider event for a deposit, exactly once: the transaction row is
   * locked first, so two deliveries of the same news can't both credit. Events that don't
   * agree with the deposit (reference, amount, currency) or arrive too late are recorded for
   * review and change no money.
   */
  async applyEvent(event: DepositEvent): Promise<DepositEventOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#db.$transaction((tx) => this.#apply(tx, event));
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  async #apply(tx: Tx, event: DepositEvent): Promise<DepositEventOutcome> {
    const provider = await tx.paymentProvider.findUniqueOrThrow({
      where: { code: this.#provider.code },
      select: { id: true, code: true },
    });
    const payment = await tx.payment.findUnique({
      where: {
        providerId_providerReference: {
          providerId: provider.id,
          providerReference: event.providerReference,
        },
      },
    });
    if (payment === null) return { outcome: 'UNMATCHED' };

    await lockTransactionRow(tx, payment.transactionId);
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: payment.transactionId },
      include: { destinationWallet: { select: { id: true, userId: true, ledgerAccountId: true } } },
    });
    const wallet = transaction.destinationWallet;
    const review = (reason: DepositReviewReason) =>
      this.#holdForReview(tx, transaction.id, transaction.reference, event, reason);

    if (
      event.kind !== 'DEPOSIT' ||
      transaction.type !== 'DEPOSIT' ||
      payment.direction !== 'INBOUND' ||
      wallet === null
    ) {
      return review('NOT_A_DEPOSIT');
    }

    // Already decided: the same news again is a no-op; contrary news needs a person.
    if (transaction.status === 'COMPLETED' || transaction.status === 'REVERSED') {
      return event.outcome === 'SUCCEEDED'
        ? { outcome: 'ALREADY_APPLIED', transactionId: transaction.id }
        : review('FAILURE_AFTER_SUCCESS');
    }
    if (transaction.status === 'FAILED' || transaction.status === 'CANCELLED') {
      return event.outcome === 'FAILED'
        ? { outcome: 'ALREADY_APPLIED', transactionId: transaction.id }
        : review('SUCCESS_AFTER_FAILURE');
    }

    if (event.reference !== transaction.reference) return review('REFERENCE_MISMATCH');
    if (event.currency !== transaction.currency) return review('CURRENCY_MISMATCH');
    if (event.amount !== transaction.amount) return review('AMOUNT_MISMATCH');
    const currency = event.currency;

    if (event.outcome === 'FAILED') {
      const reason = event.reason ?? 'The payment was not completed.';
      await transitionTransaction(tx, transaction.id, 'FAILED', {
        failureReason: reason,
        now: this.#now(),
      });
      await this.#recordProviderStatus(tx, transaction.id, event);
      await recordAudit(tx, {
        action: 'deposit.failed',
        actor: { type: 'SYSTEM' },
        resource: { type: 'transaction', id: transaction.id },
        metadata: { reference: transaction.reference, eventId: event.eventId, reason },
      });
      await writeOutboxEvent(tx, {
        type: 'deposit.failed',
        aggregate: { type: 'transaction', id: transaction.id },
        payload: {
          transactionId: transaction.id,
          reference: transaction.reference,
          userId: wallet.userId,
          reason,
        },
      });
      return { outcome: 'FAILED', transactionId: transaction.id };
    }

    // The money is at the provider. Credit it unless the wallet can't take it right now:
    // then it waits for a person (credit later, or return it), never silently refused.
    const [lockedWallet] = await lockWallets(tx, [wallet.id]);
    if (lockedWallet === undefined) return review('NOT_A_DEPOSIT');
    const refusal = walletStatusRefusal(lockedWallet.status, 'DEPOSIT');
    if (refusal !== null) return review(refusal);
    const profile = await tx.kycProfile.findUnique({
      where: { userId: wallet.userId },
      select: { tier: true },
    });
    const limits = await findTierLimits(tx, profile?.tier ?? 0, currency);
    if (
      limits === null ||
      checkInflow({
        limits,
        kind: 'DEPOSIT',
        balanceAfter: lockedWallet.ledgerBalance + transaction.amount,
      }) !== null
    ) {
      return review('MAX_BALANCE');
    }

    const settlement = await tx.ledgerAccount.findUniqueOrThrow({
      where: { code: providerSettlementAccountCode(provider.code, currency) },
      select: { id: true },
    });
    await post(tx, {
      transactionId: transaction.id,
      entries: [
        { ledgerAccountId: settlement.id, direction: 'DEBIT', amount: transaction.amount },
        {
          ledgerAccountId: wallet.ledgerAccountId,
          direction: 'CREDIT',
          amount: transaction.amount,
        },
      ],
    });
    await transitionTransaction(tx, transaction.id, 'COMPLETED', { now: this.#now() });
    await this.#recordProviderStatus(tx, transaction.id, event);
    await recordAudit(tx, {
      action: 'deposit.completed',
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: transaction.id },
      metadata: {
        reference: transaction.reference,
        eventId: event.eventId,
        amount: transaction.amount.toString(),
        currency,
        provider: provider.code,
      },
    });
    await writeOutboxEvent(tx, {
      type: 'deposit.completed',
      aggregate: { type: 'transaction', id: transaction.id },
      payload: {
        transactionId: transaction.id,
        reference: transaction.reference,
        userId: wallet.userId,
        amount: transaction.amount.toString(),
        currency,
      },
    });
    return { outcome: 'COMPLETED', transactionId: transaction.id };
  }

  async #recordProviderStatus(tx: Tx, transactionId: string, event: DepositEvent): Promise<void> {
    await tx.payment.update({
      where: { transactionId },
      data: { providerStatus: event.eventType },
    });
  }

  /**
   * Leaves the deposit as it is and records why: on the payment (for the admin queue,
   * Stage 19) and in the audit log. What the provider claimed is kept as it said it.
   */
  async #holdForReview(
    tx: Tx,
    transactionId: string,
    reference: string,
    event: DepositEvent,
    reason: DepositReviewReason,
  ): Promise<DepositEventOutcome> {
    const review = {
      reason,
      eventId: event.eventId,
      eventType: event.eventType,
      reportedAmount: event.amount.toString(),
      reportedCurrency: event.currency,
      reportedReference: event.reference,
      at: new Date(this.#now()).toISOString(),
    };
    await tx.payment.update({
      where: { transactionId },
      data: { metadata: { review } },
    });
    await recordAudit(tx, {
      action: 'deposit.review_required',
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: transactionId },
      metadata: { reference, ...review },
    });
    return { outcome: 'REVIEW', transactionId, reason };
  }
}
