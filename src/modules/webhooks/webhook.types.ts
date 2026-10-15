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
