// Money out through the payment provider: withdrawals to a bank account and bill payments
// (ARCHITECTURE §8.4–8.5). Both work the same way: the amount + fee is held and committed
// first; only then is the provider asked to pay, so it can never pay out money Fundra has no
// record of. The provider's answer (applyEvent) settles the hold into the real posting, or
// releases it. A biller's refund (applyRefund) comes back as a separate REFUND transaction.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ErrorCode,
  ForbiddenError,
  isRetryable,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
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
import { lockWallets, post } from '../ledger/ledger.service.ts';
import {
  feeRevenueAccountCode,
  providerSettlementAccountCode,
  walletStatusRefusal,
} from '../ledger/ledger.utils.ts';
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
  type RefundEvent,
} from './payment-review.ts';
import type {
  BankAccountQuery,
  CreateBillPaymentInput,
  CreateWithdrawalInput,
} from './payment.schema.ts';
import type {
  Biller,
  PaymentProvider,
  PayoutResult,
  ResolvedBankAccount,
} from './providers/payment-provider.ts';

type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;

type OutboundType = 'WITHDRAWAL' | 'PAYMENT';

/** The provider event kind that answers each outbound type. */
const EVENT_KIND = { WITHDRAWAL: 'PAYOUT', PAYMENT: 'BILL' } as const;

/** Audit actions and outbox events per type. */
const NAMES = {
  WITHDRAWAL: {
    requested: 'withdrawal.requested',
    completed: 'withdrawal.completed',
    failed: 'withdrawal.failed',
  },
  PAYMENT: {
    requested: 'payment.requested',
    completed: 'payment.completed',
    failed: 'payment.failed',
  },
} as const;

/** What sending the payment did. Anything but SENT or FAILED leaves the hold for a retry. */
export type DispatchOutcome = 'SENT' | 'FAILED' | 'NOT_SENT' | 'SKIPPED';

/** Where a bill payment goes, kept on the payment row (it has no bank columns to use). */
interface BillDestination {
  billerCode: string;
  billerName: string;
  customerReference: string;
}

/** Everything that differs between a withdrawal and a bill payment when reserving. */
interface OutboundSpec {
  type: OutboundType;
  amount: bigint;
  currency: Currency;
  description: string | null;
  payment: Pick<
    Prisma.PaymentUncheckedCreateInput,
    'bankCode' | 'bankAccountNumber' | 'bankAccountName' | 'metadata'
  >;
  /** What the response and the audit log say about where the money goes (masked). */
  destination: Record<string, string>;
}

const unavailable = (cause: unknown) =>
  new ServiceUnavailableError(
    'The payment provider is unavailable. Nothing was taken; try again shortly.',
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

export class OutboundPaymentService {
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

  /** The provider's billers. An outage is 503. */
  async listBillers(): Promise<readonly Biller[]> {
    try {
      return await this.#provider.listBillers();
    } catch (err) {
      throw unavailable(err);
    }
  }

  /** A withdrawal to a bank account; the name always comes from the bank. */
  withdraw(
    userId: string,
    input: CreateWithdrawalInput,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
  ): Promise<IdempotentResult> {
    return this.#create(userId, input.currency, idempotency, context, 'withdrawal', async () => {
      const account = await this.#resolve(input);
      if (account === null) throw bankAccountNotFound();
      return {
        type: 'WITHDRAWAL',
        amount: input.amount,
        currency: input.currency,
        description: input.description ?? null,
        payment: {
          bankCode: account.bankCode,
          bankAccountNumber: account.accountNumber,
          bankAccountName: account.accountName,
        },
        destination: {
          bankCode: account.bankCode,
          accountNumber: maskAccountNumber(account.accountNumber),
          accountName: account.accountName,
        },
      };
    });
  }

  /** A bill payment: the biller and customer reference are checked against the catalogue. */
  payBill(
    userId: string,
    input: CreateBillPaymentInput,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
  ): Promise<IdempotentResult> {
    return this.#create(userId, input.currency, idempotency, context, 'payment', async () => {
      const biller = (await this.listBillers()).find((b) => b.code === input.billerCode);
      if (biller === undefined) {
        throw new NotFoundError('No biller has that code.', { code: ErrorCode.BILLER_NOT_FOUND });
      }
      if (!new RegExp(biller.customerReferencePattern).test(input.customerReference)) {
        throw new ValidationError([
          {
            path: 'customerReference',
            message: `This is not a valid ${biller.customerReferenceLabel.toLowerCase()}`,
          },
        ]);
      }
      const bill: BillDestination = {
        billerCode: biller.code,
        billerName: biller.name,
        customerReference: input.customerReference,
      };
      return {
        type: 'PAYMENT',
        amount: input.amount,
        currency: input.currency,
        description: input.description ?? null,
        payment: { metadata: { bill: { ...bill } } },
        destination: { ...bill },
      };
    });
  }

  /**
   * At most once per Idempotency-Key, in two steps, deliberately: (1) inside the idempotency
   * transaction, the amount + fee is held and the payment committed as PROCESSING; (2) after
   * COMMIT, the provider is asked to pay. The response is the committed state; the outcome
   * arrives in history. If the provider can't be asked now, the money stays held and
   * `dispatch` is retried later (it's idempotent: the provider dedupes our reference).
   */
  async #create(
    userId: string,
    currency: Currency,
    idempotency: { key: string; fingerprint: string },
    context: AuditContext,
    responseKey: 'withdrawal' | 'payment',
    destinationOf: () => Promise<OutboundSpec>,
  ): Promise<IdempotentResult> {
    let created: string | undefined;
    let result: IdempotentResult;
    for (let attempt = 1; ; attempt++) {
      try {
        result = await this.#idempotency.run(
          { userId, key: idempotency.key, fingerprint: idempotency.fingerprint },
          async (tx) => {
            const spec = await this.#prepare(tx, userId, currency, destinationOf);
            const transactionId = await this.#reserve(tx, userId, spec, context);
            const view = await transactionViewFor(tx, userId, transactionId);
            created = transactionId;
            return {
              status: 201,
              body: success({ [responseKey]: view, destination: spec.destination }),
              transactionId,
            };
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

  /** Who may pay, and where to: checked before any lock is taken (the provider may be slow). */
  async #prepare(
    tx: Tx,
    userId: string,
    currency: Currency,
    destinationOf: () => Promise<OutboundSpec>,
  ): Promise<OutboundSpec> {
    const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
    if (wallet === null) {
      throw new ForbiddenError('Complete KYC Tier 1 to get a wallet before paying out.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }
    const provider = await tx.paymentProvider.findUnique({ where: { code: this.#provider.code } });
    if (provider?.isActive !== true) {
      throw unavailable(new Error(`Payment provider ${this.#provider.code} is not active`));
    }
    return destinationOf();
  }

  async #reserve(
    tx: Tx,
    userId: string,
    spec: OutboundSpec,
    context: AuditContext,
  ): Promise<string> {
    const now = this.#now();
    const { currency } = spec;
    const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
    const profile = await tx.kycProfile.findUnique({ where: { userId }, select: { tier: true } });
    const limits = wallet === null ? null : await findTierLimits(tx, profile?.tier ?? 0, currency);
    if (wallet === null || limits === null) {
      throw new ForbiddenError('Complete KYC Tier 1 to get a wallet before paying out.', {
        code: ErrorCode.KYC_REQUIRED,
      });
    }
    const provider = await tx.paymentProvider.findUniqueOrThrow({
      where: { code: this.#provider.code },
      select: { id: true },
    });
    const fee = await feeFor(tx, spec.type, spec.amount, currency, now);

    // Limits against the locked wallet, as for transfers; placeHold re-checks status and funds.
    await lockWallets(tx, [wallet.id]);
    const outflow = checkOutflow({
      limits,
      amount: spec.amount,
      fee,
      outflowToday: await outflowToday(tx, wallet.id, now),
    });
    if (outflow !== null) throw outflowLimitError(outflow, currency);

    const transaction = await createTransaction(
      tx,
      {
        type: spec.type,
        currency,
        amount: spec.amount,
        fee,
        sourceWalletId: wallet.id,
        initiatedByUserId: userId,
        description: spec.description,
      },
      now,
    );
    await placeHold(tx, {
      transactionId: transaction.id,
      walletId: wallet.id,
      amount: spec.amount + fee,
    });
    await tx.payment.create({
      data: {
        transactionId: transaction.id,
        providerId: provider.id,
        direction: 'OUTBOUND',
        providerStatus: 'queued',
        ...spec.payment,
      },
    });
    await transitionTransaction(tx, transaction.id, 'PROCESSING', { now });

    await recordAudit(tx, {
      action: NAMES[spec.type].requested,
      actor: { type: 'USER', userId },
      resource: { type: 'transaction', id: transaction.id },
      context,
      metadata: {
        reference: transaction.reference,
        amount: spec.amount.toString(),
        fee: fee.toString(),
        currency,
        ...spec.destination,
      },
    });
    return transaction.id;
  }

  /**
   * Asks the provider to pay a held withdrawal or bill payment. Safe to call again (a retry
   * job, after a crash or an outage): it acts only on a PROCESSING payment not yet sent, and
   * the provider returns the same payment for the same reference. Never throws: a payment
   * that can't be sent now stays held, with the reason on the payment, for the next attempt.
   */
  async dispatch(transactionId: string): Promise<DispatchOutcome> {
    const payment = await this.#db.payment.findUnique({
      where: { transactionId },
      include: { transaction: true },
    });
    const transaction = payment?.transaction;
    if (
      payment?.direction !== 'OUTBOUND' ||
      transaction === undefined ||
      (transaction.type !== 'WITHDRAWAL' && transaction.type !== 'PAYMENT') ||
      transaction.status !== 'PROCESSING' ||
      payment.providerReference !== null
    ) {
      return 'SKIPPED';
    }

    let result: PayoutResult;
    try {
      const common = {
        reference: transaction.reference,
        amount: transaction.amount,
        currency: transaction.currency as Currency,
      };
      if (transaction.type === 'WITHDRAWAL') {
        if (
          payment.bankCode === null ||
          payment.bankAccountNumber === null ||
          payment.bankAccountName === null
        ) {
          throw new Error(`Withdrawal ${transactionId} has no bank account`);
        }
        result = await this.#provider.sendPayout({
          ...common,
          destination: {
            bankCode: payment.bankCode,
            accountNumber: payment.bankAccountNumber,
            accountName: payment.bankAccountName,
          },
          narration: transaction.description ?? `Fundra ${transaction.reference}`,
        });
      } else {
        const bill = billOf(payment);
        if (bill === null) throw new Error(`Bill payment ${transactionId} has no biller`);
        result = await this.#provider.payBill({
          ...common,
          billerCode: bill.billerCode,
          customerReference: bill.customerReference,
        });
      }
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
    const { providerReference, reason } = result;
    await this.#db.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { transactionId, providerReference: null },
        data: { providerReference, providerStatus: 'rejected' },
      });
      await this.#fail(tx, transactionId, reason, null);
    });
    return 'FAILED';
  }

  /**
   * Applies a verified provider event for a payout or bill payment, exactly once (the
   * transaction row is locked first). Success settles the hold into the real posting;
   * failure releases it.
   */
  async applyEvent(event: PaymentEvent): Promise<PaymentEventOutcome> {
    return this.#inTransaction((tx) => this.#apply(tx, event));
  }

  /**
   * A biller gave money back for a completed bill payment: credited as its own REFUND
   * transaction (the payment stays COMPLETED), once per refund reference, never more in
   * total than was paid.
   */
  async applyRefund(event: RefundEvent): Promise<PaymentEventOutcome> {
    return this.#inTransaction((tx) => this.#refund(tx, event));
  }

  async #inTransaction(
    work: (tx: Tx) => Promise<PaymentEventOutcome>,
  ): Promise<PaymentEventOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#db.$transaction(work);
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      }
    }
  }

  async #apply(tx: Tx, event: PaymentEvent): Promise<PaymentEventOutcome> {
    const provider = await this.#providerRow(tx);
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

    const type = transaction.type;
    if (
      (type !== 'WITHDRAWAL' && type !== 'PAYMENT') ||
      event.kind !== EVENT_KIND[type] ||
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
    // The provider pays the amount; the fee never leaves Fundra.
    if (event.amount !== transaction.amount) return review('AMOUNT_MISMATCH');

    if (event.outcome === 'FAILED') {
      await recordProviderStatus(tx, transaction.id, event);
      await this.#fail(
        tx,
        transaction.id,
        event.reason ??
          (type === 'WITHDRAWAL'
            ? 'The bank did not accept the transfer.'
            : 'The biller did not accept the payment.'),
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
      action: NAMES[type].completed,
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
      type: NAMES[type].completed,
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

  async #refund(tx: Tx, event: RefundEvent): Promise<PaymentEventOutcome> {
    const provider = await this.#providerRow(tx);
    const payment = await tx.payment.findUnique({
      where: {
        providerId_providerReference: {
          providerId: provider.id,
          providerReference: event.providerReference,
        },
      },
    });
    if (payment === null) return { outcome: 'UNMATCHED' };

    // The original's row lock serialises every refund of it.
    await lockTransactionRow(tx, payment.transactionId);
    const original = await tx.transaction.findUniqueOrThrow({
      where: { id: payment.transactionId },
      include: { sourceWallet: { select: { id: true, userId: true, ledgerAccountId: true } } },
    });
    const wallet = original.sourceWallet;
    const review = (reason: PaymentReviewReason) =>
      holdForReview(tx, {
        transactionId: original.id,
        reference: original.reference,
        event,
        reason,
        now: this.#now(),
      });

    if (original.type !== 'PAYMENT' || payment.direction !== 'OUTBOUND' || wallet === null) {
      return review('WRONG_KIND');
    }
    const refunds = await tx.transaction.findMany({
      where: { type: 'REFUND', metadata: { path: ['refundOf'], equals: original.id } },
      select: { id: true, amount: true, metadata: true },
    });
    const same = refunds.find(
      (r) => jsonObject(r.metadata).refundReference === event.refundReference,
    );
    if (same !== undefined) return { outcome: 'ALREADY_APPLIED', transactionId: same.id };
    if (original.status !== 'COMPLETED') return review('NOT_REFUNDABLE');
    if (event.reference !== original.reference) return review('REFERENCE_MISMATCH');
    if (event.currency !== original.currency) return review('CURRENCY_MISMATCH');
    const refundedSoFar = refunds.reduce((sum, r) => sum + r.amount, 0n);
    if (refundedSoFar + event.amount > original.amount) return review('REFUND_EXCEEDS_PAYMENT');

    // Refunds pass frozen wallets and limits (the user's own money), but not a closed wallet.
    const [locked] = await lockWallets(tx, [wallet.id]);
    if (locked === undefined || walletStatusRefusal(locked.status, 'REFUND') === 'WALLET_CLOSED') {
      return review('WALLET_CLOSED');
    }
    const currency = event.currency;
    const now = this.#now();
    const refund = await createTransaction(
      tx,
      {
        type: 'REFUND',
        currency,
        amount: event.amount,
        destinationWalletId: wallet.id,
        description: event.reason ?? null,
        metadata: {
          kind: 'PAYMENT_REFUND',
          refundOf: original.id,
          refundReference: event.refundReference,
          eventId: event.eventId,
        },
      },
      now,
    );
    const settlement = await tx.ledgerAccount.findUniqueOrThrow({
      where: { code: providerSettlementAccountCode(provider.code, currency) },
      select: { id: true },
    });
    await post(tx, {
      transactionId: refund.id,
      entries: [
        { ledgerAccountId: settlement.id, direction: 'DEBIT', amount: event.amount },
        { ledgerAccountId: wallet.ledgerAccountId, direction: 'CREDIT', amount: event.amount },
      ],
    });
    await transitionTransaction(tx, refund.id, 'COMPLETED', { now });
    await recordAudit(tx, {
      action: 'payment.refunded',
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: original.id },
      metadata: {
        reference: original.reference,
        refundTransactionId: refund.id,
        refundReference: event.refundReference,
        eventId: event.eventId,
        amount: event.amount.toString(),
        currency,
      },
    });
    await writeOutboxEvent(tx, {
      type: 'payment.refunded',
      aggregate: { type: 'transaction', id: original.id },
      payload: {
        transactionId: refund.id,
        refundOf: original.id,
        reference: refund.reference,
        userId: wallet.userId,
        amount: event.amount.toString(),
        currency,
      },
    });
    return { outcome: 'COMPLETED', transactionId: refund.id };
  }

  #providerRow(tx: Tx): Promise<{ id: string; code: string }> {
    return tx.paymentProvider.findUniqueOrThrow({
      where: { code: this.#provider.code },
      select: { id: true, code: true },
    });
  }

  /**
   * By provider reference; failing that, by our own reference for a payment whose provider
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

  /** Releases the hold and marks the payment FAILED (if it's still in flight). */
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
    const type = transaction.type;
    if (
      transaction.status !== 'PROCESSING' ||
      transaction.sourceWallet === null ||
      (type !== 'WITHDRAWAL' && type !== 'PAYMENT')
    ) {
      return;
    }
    await releaseHold(tx, { transactionId });
    await transitionTransaction(tx, transactionId, 'FAILED', {
      failureReason: reason,
      now: this.#now(),
    });
    await recordAudit(tx, {
      action: NAMES[type].failed,
      actor: { type: 'SYSTEM' },
      resource: { type: 'transaction', id: transactionId },
      metadata: { reference: transaction.reference, eventId, reason },
    });
    await writeOutboxEvent(tx, {
      type: NAMES[type].failed,
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

function billOf(payment: Payment): BillDestination | null {
  const bill = jsonObject(jsonObject(payment.metadata).bill ?? null);
  const { billerCode, billerName, customerReference } = bill;
  return typeof billerCode === 'string' &&
    typeof billerName === 'string' &&
    typeof customerReference === 'string'
    ? { billerCode, billerName, customerReference }
    : null;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
