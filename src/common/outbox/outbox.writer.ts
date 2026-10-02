// Transactional outbox writer (docs/ARCHITECTURE.md §9.1).
import type { Prisma } from '../../generated/prisma/client.ts';
import type { OutboxEvent, OutboxEventType } from './outbox.types.ts';

/** The interactive-transaction client of the business action (`tx`). */
export type OutboxWriter = Pick<Prisma.TransactionClient, 'outboxEvent'>;

export const MAX_OUTBOX_PAYLOAD_BYTES = 16_384;

/**
 * Records an event in the outbox **inside the caller's transaction**, so it commits or rolls
 * back with the business change: no lost notifications (crash after commit) and no phantom
 * ones (enqueued, then rolled back). The Stage 16 relay publishes it to BullMQ.
 *
 * Returns the event ID, which doubles as the job ID so consumers can deduplicate
 * (delivery is at-least-once).
 *
 * Throws before COMMIT if the payload isn't JSON-safe or is too large, so the action rolls
 * back rather than committing with a broken or missing event.
 */
export async function writeOutboxEvent<T extends OutboxEventType>(
  tx: OutboxWriter,
  event: OutboxEvent<T>,
): Promise<string> {
  const json = JSON.stringify(event.payload);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_OUTBOX_PAYLOAD_BYTES) {
    throw new Error(
      `Outbox payload for ${event.type} is ${String(bytes)} bytes (max ${String(MAX_OUTBOX_PAYLOAD_BYTES)}). Send identifiers, not documents.`,
    );
  }

  const row = await tx.outboxEvent.create({
    data: {
      eventType: event.type,
      aggregateType: event.aggregate.type,
      aggregateId: event.aggregate.id,
      payload: JSON.parse(json) as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  return row.id;
}
