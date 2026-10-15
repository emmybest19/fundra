// The PaymentProvider contract: how Fundra moves money in and out through an outside payment
// service. The payments and webhooks modules depend only on this; adapters (the mock now, a
// Paystack or Flutterwave sandbox later) live next to it and translate their API to it.
import type { IncomingHttpHeaders } from 'node:http';
import type { Currency } from '../../../common/constants/currency.ts';

/** Matches `payment_providers.code` and the `PROVIDER_SETTLEMENT:<code>:<ccy>` ledger accounts. */
export type PaymentProviderCode = 'MOCK';

export interface DepositRequest {
  /** Fundra's transaction reference. Providers reject a reused reference, so a retry is safe. */
  reference: string;
  /** Minor units, > 0. */
  amount: bigint;
  currency: Currency;
  /** Providers send the receipt here. */
  email: string;
}

export interface DepositSession {
  providerReference: string;
  /** Where the customer pays. Its redirect back proves nothing: only the webhook decides. */
  checkoutUrl: string;
}

export interface BankAccount {
  /** CBN bank code, e.g. `058`. */
  bankCode: string;
  /** 10-digit NUBAN. */
  accountNumber: string;
}

/** Name enquiry result: the name the bank holds, shown to the customer before they confirm. */
export interface ResolvedBankAccount extends BankAccount {
  accountName: string;
}

export interface PayoutRequest {
  reference: string;
  amount: bigint;
  currency: Currency;
  /** A resolved account: the name is checked again by the bank. */
  destination: ResolvedBankAccount;
  /** Shown on the recipient's bank statement. */
  narration: string;
}

/**
 * A payout is asynchronous: `PENDING` means accepted and the webhook will settle it. `FAILED`
 * means refused on the spot, so no money left and none will.
 */
export type PayoutResult =
  | { providerReference: string; status: 'PENDING' }
  | { providerReference: string; status: 'FAILED'; reason: string };

/** Someone Fundra users can pay through the provider: an airtime network, TV, electricity. */
export interface Biller {
  code: string;
  name: string;
  category: 'AIRTIME' | 'DATA' | 'TV' | 'ELECTRICITY';
  /** What the customer types, e.g. "Phone number", "Smartcard number", "Meter number". */
  customerReferenceLabel: string;
  /** A regular expression the customer reference must match, checked before paying. */
  customerReferencePattern: string;
}

export interface BillPaymentRequest {
  reference: string;
  amount: bigint;
  currency: Currency;
  billerCode: string;
  /** The phone, smartcard or meter number being paid for. */
  customerReference: string;
}

/** The provider's view of a payment, for reconciliation when a webhook never arrives. */
export interface ProviderPaymentStatus {
  providerReference: string;
  reference: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amount: bigint;
  currency: Currency;
  reason?: string;
}

/**
 * A verified webhook, normalized. Amount and currency are what the provider says moved;
 * the processor checks them against the transaction before touching the ledger. Event types
 * Fundra doesn't act on come back as `OTHER`, to be stored and ignored.
 */
export type ProviderEvent =
  | {
      kind: 'DEPOSIT' | 'PAYOUT' | 'BILL';
      outcome: 'SUCCEEDED' | 'FAILED';
      /** The provider's event ID: the deduplication key. */
      eventId: string;
      /** The provider's own name for the event, kept for support. */
      eventType: string;
      providerReference: string;
      reference: string;
      amount: bigint;
      currency: Currency;
      reason?: string;
    }
  /**
   * Money given back for a completed bill payment, in full or in part. `refundReference` is
   * the provider's ID for this refund: the same refund reported twice is credited once.
   */
  | {
      kind: 'REFUND';
      eventId: string;
      eventType: string;
      /** The original payment's provider reference and Fundra reference. */
      providerReference: string;
      reference: string;
      refundReference: string;
      amount: bigint;
      currency: Currency;
      reason?: string;
    }
  | { kind: 'OTHER'; eventId: string; eventType: string };

export interface PaymentProvider {
  readonly code: PaymentProviderCode;
  initializeDeposit(request: DepositRequest): Promise<DepositSession>;
  /** `null` when the bank has no such account. */
  resolveBankAccount(account: BankAccount): Promise<ResolvedBankAccount | null>;
  sendPayout(request: PayoutRequest): Promise<PayoutResult>;
  listBillers(): Promise<readonly Biller[]>;
  /** Asynchronous like a payout: PENDING until the webhook, or FAILED on the spot. */
  payBill(request: BillPaymentRequest): Promise<PayoutResult>;
  /** `null` for a reference the provider never issued. */
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null>;
  /** Checks the signature over the exact bytes received, in constant time. */
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Call only after `verifyWebhook`. `null` when the payload is malformed. */
  parseWebhook(rawBody: Buffer): ProviderEvent | null;
}

/**
 * The provider timed out, is down or answered with something unusable. Whether money moved
 * is unknown, so callers keep the attempt open and reconcile; the service maps this to 503.
 */
export class PaymentProviderUnavailableError extends Error {
  constructor(provider: PaymentProviderCode, options?: { cause?: unknown }) {
    super(`Payment provider ${provider} is unavailable`, options);
    this.name = 'PaymentProviderUnavailableError';
  }
}
