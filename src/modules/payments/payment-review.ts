// Provider events Fundra can't trust are held for a person, never applied and never silently
// dropped. Shared by deposits and withdrawals; the admin queue that resolves them is Stage 19.
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { ProviderEvent } from './providers/payment-provider.ts';

type Tx = Prisma.TransactionClient;

export type PaymentEvent = Extract<ProviderEvent, { kind: 'DEPOSIT' | 'PAYOUT' }>;

/** Why an event was held instead of applied. Each needs a person to look at it. */
export type PaymentReviewReason =
  /** The event is about another kind of payment (e.g. a payout event for a deposit). */
  | 'WRONG_KIND'
  | 'REFERENCE_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  /** Success reported after Fundra marked it FAILED: money may have moved after all. */
  | 'SUCCESS_AFTER_FAILURE'
  /** Failure reported for a payment already completed. */
  | 'FAILURE_AFTER_SUCCESS'
  /** Deposits only: the wallet can't take the money right now. */
  | 'WALLET_FROZEN'
  | 'WALLET_CLOSED'
  | 'MAX_BALANCE';

/** What applying a provider event did; the webhook processor records it on the event. */
export type PaymentEventOutcome =
  | { outcome: 'COMPLETED' | 'FAILED'; transactionId: string }
  /** The payment already had this outcome: a re-notification, nothing to do. */
  | { outcome: 'ALREADY_APPLIED'; transactionId: string }
  | { outcome: 'REVIEW'; transactionId: string; reason: PaymentReviewReason }
  /** No payment has this provider reference. */
  | { outcome: 'UNMATCHED' };

/**
 * Leaves the payment as it is and records why: on the payment (for the admin queue) and in
 * the audit log. What the provider claimed is kept exactly as it said it.
 */
export async function holdForReview(
  tx: Tx,
  input: {
    transactionId: string;
    reference: string;
    event: PaymentEvent;
    reason: PaymentReviewReason;
    now: number;
  },
): Promise<PaymentEventOutcome> {
  const { transactionId, reference, event, reason, now } = input;
  const review = {
    reason,
    eventId: event.eventId,
    eventType: event.eventType,
    reportedAmount: event.amount.toString(),
    reportedCurrency: event.currency,
    reportedReference: event.reference,
    at: new Date(now).toISOString(),
  };
  const payment = await tx.payment.findUniqueOrThrow({
    where: { transactionId },
    select: { metadata: true },
  });
  await tx.payment.update({
    where: { transactionId },
    data: { metadata: { ...jsonObject(payment.metadata), review } },
  });
  await recordAudit(tx, {
    action: 'payment.review_required',
    actor: { type: 'SYSTEM' },
    resource: { type: 'transaction', id: transactionId },
    metadata: { reference, ...review },
  });
  return { outcome: 'REVIEW', transactionId, reason };
}

/** Keeps the provider's own word for where the payment stands, for support. */
export async function recordProviderStatus(
  tx: Tx,
  transactionId: string,
  event: PaymentEvent,
): Promise<void> {
  await tx.payment.update({ where: { transactionId }, data: { providerStatus: event.eventType } });
}

/** A payment's metadata as an object, so a new key can be added without losing the others. */
export function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
