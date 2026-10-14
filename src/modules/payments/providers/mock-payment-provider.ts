// MockPaymentProvider: a deterministic stand-in for a payment provider, shaped like a
// Paystack-style API. Reserved account numbers decide payout outcomes, like a sandbox, and
// test hooks produce correctly signed webhooks so deposits and withdrawals can be driven end
// to end. Nothing it does moves real money.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { CURRENCIES, type Currency } from '../../../common/constants/currency.ts';
import {
  PaymentProviderUnavailableError,
  type BankAccount,
  type DepositRequest,
  type DepositSession,
  type PaymentProvider,
  type PayoutRequest,
  type PayoutResult,
  type ProviderEvent,
  type ProviderPaymentStatus,
  type ResolvedBankAccount,
} from './payment-provider.ts';

/** Reserved account numbers. Any other 10-digit number resolves and is paid out. */
export const MOCK_ACCOUNT_NUMBERS = {
  /** Name enquiry finds no account. */
  NOT_FOUND: '0000000001',
  /** The payout is accepted, then the webhook reports it failed. */
  FAILS_LATER: '0000000002',
  /** The payout is refused on the spot. */
  REJECTED: '0000000003',
} as const;

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

const EVENT_TYPES = {
  DEPOSIT: { SUCCEEDED: 'charge.success', FAILED: 'charge.failed' },
  PAYOUT: { SUCCEEDED: 'transfer.success', FAILED: 'transfer.failed' },
} as const;

const KNOWN_EVENTS = new Map<string, { kind: 'DEPOSIT' | 'PAYOUT'; outcome: Outcome }>([
  ['charge.success', { kind: 'DEPOSIT', outcome: 'SUCCEEDED' }],
  ['charge.failed', { kind: 'DEPOSIT', outcome: 'FAILED' }],
  ['transfer.success', { kind: 'PAYOUT', outcome: 'SUCCEEDED' }],
  ['transfer.failed', { kind: 'PAYOUT', outcome: 'FAILED' }],
]);

type Outcome = 'SUCCEEDED' | 'FAILED';

/** The wire format. Amounts are minor-unit strings so no JSON number loses precision. */
const webhookPayload = z.object({
  id: z.string().min(1).max(200),
  event: z.string().min(1).max(100),
  data: z
    .object({
      reference: z.string().min(1).max(100),
      provider_reference: z.string().min(1).max(200),
      amount: z.string().regex(/^[1-9]\d{0,18}$/),
      currency: z.enum(CURRENCIES),
      reason: z.string().max(500).optional(),
    })
    .optional(),
});

interface MockPayment {
  kind: 'DEPOSIT' | 'PAYOUT';
  providerReference: string;
  reference: string;
  amount: bigint;
  currency: Currency;
  status: 'PENDING' | Outcome;
  /** What settling this payment will report, unless a test overrides it. */
  plannedOutcome: Outcome;
  reason?: string;
}

/** `500000 NGN`: amount and currency compared as one. */
function money(payment: { amount: bigint; currency: Currency }): string {
  return `${payment.amount.toString()} ${payment.currency}`;
}

export interface SignedWebhook {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly code = 'MOCK' as const;
  readonly #webhookSecret: string;
  readonly #payments = new Map<string, MockPayment>();
  /** Fundra reference → provider reference: a repeated request returns the same payment. */
  readonly #byReference = new Map<string, string>();
  #available = true;

  constructor(options: { webhookSecret: string }) {
    if (options.webhookSecret.length < 32) {
      throw new Error('The mock webhook secret must be at least 32 characters');
    }
    this.#webhookSecret = options.webhookSecret;
  }

  initializeDeposit(request: DepositRequest): Promise<DepositSession> {
    return this.#call(() => {
      const payment = this.#open('DEPOSIT', request, 'SUCCEEDED');
      return {
        providerReference: payment.providerReference,
        // `.invalid` is reserved (RFC 2606): this page can never exist.
        checkoutUrl: `https://checkout.mock-payments.invalid/pay/${payment.providerReference}`,
      };
    });
  }

  resolveBankAccount(account: BankAccount): Promise<ResolvedBankAccount | null> {
    return this.#call(() => {
      if (
        !/^\d{3,6}$/.test(account.bankCode) ||
        !/^\d{10}$/.test(account.accountNumber) ||
        account.accountNumber === MOCK_ACCOUNT_NUMBERS.NOT_FOUND
      ) {
        return null;
      }
      return { ...account, accountName: `MOCK ACCOUNT ${account.accountNumber.slice(-4)}` };
    });
  }

  sendPayout(request: PayoutRequest): Promise<PayoutResult> {
    return this.#call(() => {
      const { accountNumber } = request.destination;
      if (accountNumber === MOCK_ACCOUNT_NUMBERS.NOT_FOUND) {
        throw new Error('Payout to an account that does not resolve');
      }
      const payment = this.#open(
        'PAYOUT',
        request,
        accountNumber === MOCK_ACCOUNT_NUMBERS.FAILS_LATER ? 'FAILED' : 'SUCCEEDED',
      );
      if (accountNumber === MOCK_ACCOUNT_NUMBERS.REJECTED && payment.status === 'PENDING') {
        payment.status = 'FAILED';
        payment.reason = 'The destination bank declined the transfer';
      }
      return payment.status === 'FAILED'
        ? {
            providerReference: payment.providerReference,
            status: 'FAILED',
            reason: payment.reason ?? 'Payout failed',
          }
        : { providerReference: payment.providerReference, status: 'PENDING' };
    });
  }

  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null> {
    return this.#call(() => {
      const payment = this.#payments.get(providerReference);
      if (payment === undefined) return null;
      return {
        providerReference,
        reference: payment.reference,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        ...(payment.reason === undefined ? {} : { reason: payment.reason }),
      };
    });
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const signature = headers[MOCK_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false;
    return timingSafeEqual(Buffer.from(signature, 'hex'), this.#sign(rawBody));
  }

  parseWebhook(rawBody: Buffer): ProviderEvent | null {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const parsed = webhookPayload.safeParse(json);
    if (!parsed.success) return null;
    const { id, event, data } = parsed.data;

    const known = KNOWN_EVENTS.get(event);
    if (known === undefined) return { kind: 'OTHER', eventId: id, eventType: event };
    if (data === undefined) return null;
    return {
      ...known,
      eventId: id,
      eventType: event,
      providerReference: data.provider_reference,
      reference: data.reference,
      amount: BigInt(data.amount),
      currency: data.currency,
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    };
  }

  // ─── Test hooks ────────────────────────────────────────────────────────────

  /** Simulates an outage: every API call fails with PaymentProviderUnavailableError. */
  setAvailable(available: boolean): void {
    this.#available = available;
  }

  /**
   * Finishes a pending payment and returns the webhook the provider would send. Deposits
   * succeed and payouts follow their account number, unless `outcome` says otherwise;
   * `amount` lets a test send a webhook that disagrees with the payment. Settling a finished
   * payment again reports the same outcome under a new event ID, as a provider re-notifying
   * does; resend the returned bytes to simulate a duplicate delivery.
   */
  settle(
    providerReference: string,
    overrides: { outcome?: Outcome; amount?: bigint; reason?: string } = {},
  ): SignedWebhook {
    const payment = this.#payments.get(providerReference);
    if (payment === undefined) throw new Error(`Unknown provider reference ${providerReference}`);
    const outcome = overrides.outcome ?? payment.plannedOutcome;
    if (payment.status !== 'PENDING' && payment.status !== outcome) {
      throw new Error(`Payment ${providerReference} already ${payment.status}`);
    }
    payment.status = outcome;
    if (outcome === 'FAILED') {
      payment.reason ??=
        overrides.reason ??
        (payment.kind === 'DEPOSIT' ? 'The card was declined' : 'The beneficiary bank is offline');
    }
    return this.signedWebhook({
      id: `evt_${randomUUID()}`,
      event: EVENT_TYPES[payment.kind][outcome],
      data: {
        reference: payment.reference,
        provider_reference: providerReference,
        amount: (overrides.amount ?? payment.amount).toString(),
        currency: payment.currency,
        ...(payment.reason === undefined ? {} : { reason: payment.reason }),
      },
    });
  }

  /** Any payload, signed as the provider would sign it (for malformed or unknown events). */
  signedWebhook(payload: unknown): SignedWebhook {
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [MOCK_SIGNATURE_HEADER]: this.#sign(rawBody).toString('hex'),
      },
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  #sign(rawBody: Buffer): Buffer {
    return createHmac('sha512', this.#webhookSecret).update(rawBody).digest();
  }

  /** Every API call fails as a whole during an outage, before any state changes. */
  #call<T>(work: () => T): Promise<T> {
    if (!this.#available) return Promise.reject(new PaymentProviderUnavailableError(this.code));
    try {
      return Promise.resolve(work());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * A reused reference returns the existing payment if it describes the same money, and is
   * refused otherwise, as real providers refuse a duplicate reference.
   */
  #open(
    kind: MockPayment['kind'],
    request: { reference: string; amount: bigint; currency: Currency },
    plannedOutcome: Outcome,
  ): MockPayment {
    if (request.amount <= 0n) throw new Error('Amount must be positive');
    const existingReference = this.#byReference.get(request.reference);
    if (existingReference !== undefined) {
      const existing = this.#payments.get(existingReference);
      if (existing?.kind !== kind || money(existing) !== money(request)) {
        throw new Error(`Duplicate reference ${request.reference}`);
      }
      return existing;
    }
    const payment: MockPayment = {
      kind,
      providerReference: `mock_${randomUUID()}`,
      reference: request.reference,
      amount: request.amount,
      currency: request.currency,
      status: 'PENDING',
      plannedOutcome,
    };
    this.#payments.set(payment.providerReference, payment);
    this.#byReference.set(request.reference, payment.providerReference);
    return payment;
  }
}
