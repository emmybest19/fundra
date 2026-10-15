// Receives payment-provider webhooks: verify → parse → dedupe by event ID → persist
// (docs/ARCHITECTURE.md §8.6). Nothing is stored before the signature checks out, and the
// unique (provider_id, event_id) index is what makes a replayed delivery a no-op.
import type { IncomingHttpHeaders } from 'node:http';
import {
  BadRequestError,
  ErrorCode,
  isUniqueViolation,
  UnauthorizedError,
} from '../../common/errors/index.ts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import type { PaymentProvider } from '../payments/providers/payment-provider.ts';
import type { ReceivedWebhook } from './webhook.types.ts';

export class WebhookService {
  readonly #db: PrismaClient;
  readonly #provider: PaymentProvider;

  constructor(db: PrismaClient, provider: PaymentProvider) {
    this.#db = db;
    this.#provider = provider;
  }

  /**
   * Stores a verified delivery once. A bad signature is refused before anything is read or
   * kept; a signed but malformed body is refused too (nothing to dedupe on). Events Fundra
   * doesn't act on are stored as IGNORED, so the provider stops retrying them.
   */
  async receive(rawBody: Buffer, headers: IncomingHttpHeaders): Promise<ReceivedWebhook> {
    if (!this.#provider.verifyWebhook(rawBody, headers)) {
      throw new UnauthorizedError('Invalid webhook signature.', {
        code: ErrorCode.INVALID_WEBHOOK_SIGNATURE,
      });
    }
    const event = this.#provider.parseWebhook(rawBody);
    if (event === null) throw new BadRequestError('Malformed webhook payload.');
    // The provider signed exactly these bytes, so they parse (parseWebhook just did).
    const payload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;

    const provider = await this.#db.paymentProvider.findUniqueOrThrow({
      where: { code: this.#provider.code },
      select: { id: true },
    });
    try {
      const row = await this.#db.webhookEvent.create({
        data: {
          providerId: provider.id,
          eventId: event.eventId,
          eventType: event.eventType,
          payload,
          status: event.kind === 'OTHER' ? 'IGNORED' : 'RECEIVED',
          ...(event.kind === 'OTHER' ? { processedAt: new Date() } : {}),
        },
        select: { id: true, status: true },
      });
      return {
        webhookEventId: row.id,
        eventId: event.eventId,
        status: row.status === 'IGNORED' ? 'IGNORED' : 'ACCEPTED',
      };
    } catch (err) {
      if (!isUniqueViolation(err, 'webhook_events_provider_id_event_id_key')) throw err;
      const existing = await this.#db.webhookEvent.findUniqueOrThrow({
        where: { providerId_eventId: { providerId: provider.id, eventId: event.eventId } },
        select: { id: true },
      });
      return { webhookEventId: existing.id, eventId: event.eventId, status: 'DUPLICATE' };
    }
  }
}
