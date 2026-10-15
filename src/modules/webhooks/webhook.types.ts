// Webhook types.

/**
 * What receiving a delivery did. ACCEPTED: stored for processing. DUPLICATE: this event ID
 * was already stored, so nothing new happened. IGNORED: stored, but Fundra doesn't act on it.
 */
export interface ReceivedWebhook {
  webhookEventId: string;
  eventId: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'IGNORED';
}

/** What processing a stored event did, as recorded on it. */
export interface ProcessedWebhook {
  webhookEventId: string;
  status: 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'IGNORED';
  /** True when the event was already done (or out of attempts) and nothing ran. */
  skipped: boolean;
  /** The payment services' answer, when they ran. */
  outcome?: 'COMPLETED' | 'FAILED' | 'ALREADY_APPLIED' | 'REVIEW' | 'UNMATCHED';
  lastError?: string;
}
