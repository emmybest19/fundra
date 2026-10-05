// Outbox event catalogue: every event type and the exact payload it carries.
//
// Payloads hold identifiers and facts, not personal data: the consumer (e.g. the notification
// worker) loads names and contact details when it runs. Amounts are minor-unit strings, as in
// the API, so payloads are always valid JSON. Modules add their events here as they're built.
import type { Currency } from '../constants/currency.ts';

/** Minor units as a decimal string, e.g. "1000000" = ₦10,000.00. */
type AmountString = string;

export interface OutboxEventPayloads {
  'transfer.completed': {
    transactionId: string;
    reference: string;
    senderUserId: string;
    recipientUserId: string;
    amount: AmountString;
    fee: AmountString;
    currency: Currency;
  };
  'transfer.failed': {
    transactionId: string;
    reference: string;
    senderUserId: string;
    reason: string;
  };
  'deposit.completed': {
    transactionId: string;
    reference: string;
    userId: string;
    amount: AmountString;
    currency: Currency;
  };
  'withdrawal.completed': {
    transactionId: string;
    reference: string;
    userId: string;
    amount: AmountString;
    currency: Currency;
  };
  'withdrawal.failed': {
    transactionId: string;
    reference: string;
    userId: string;
    reason: string;
  };
  'kyc.status_changed': {
    userId: string;
    status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'IN_REVIEW';
    tier: number;
  };
  'auth.login_succeeded': {
    userId: string;
    sessionId: string;
    /** First sign-in from this deviceId (or no deviceId sent): drives "new device" alerts. */
    newDevice: boolean;
  };
  'auth.password_changed': {
    userId: string;
  };
  'user.contact_changed': {
    userId: string;
    changed: 'email' | 'phone';
  };
  'user.deactivated': {
    userId: string;
    walletsClosed: number;
  };
}

export type OutboxEventType = keyof OutboxEventPayloads;

export interface OutboxEvent<T extends OutboxEventType> {
  type: T;
  /** What the event is about, e.g. `{ type: 'transaction', id: transactionId }`. */
  aggregate: { type: string; id: string };
  payload: OutboxEventPayloads[T];
}
