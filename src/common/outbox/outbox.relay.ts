// Outbox relay: publishes committed outbox events to the job queue (docs/ARCHITECTURE.md §9.1).
// Runs as the recurring `outbox-relay` job. Delivery is at-least-once: an event can be queued
// and then not marked published (a crash before COMMIT), so it is queued again next run under
// the same job ID (= event ID), which BullMQ deduplicates, and consumers dedupe by it too.
import type { Queue } from 'bullmq';
import type { PrismaClient } from '../../generated/prisma/client.ts';

/** Events per run. At one run a second this is far above Fundra's event rate. */
export const OUTBOX_BATCH_SIZE = 100;

/** What a consumer receives: the event as written, with its ID for deduplication. */
export interface OutboxJobData {
  outboxEventId: string;
  eventType: string;
  aggregate: { type: string; id: string };
  payload: unknown;
  createdAt: string;
}

export interface RelayResult {
  /** Events taken in this run (locked, attempt counted). */
  claimed: number;
  /** Queued and marked published. */
  published: number;
  /** Queueing failed: left unpublished for the next run. */
  failed: number;
}

interface ClaimedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}

export class OutboxRelay {
  readonly #db: PrismaClient;
  /** Every event goes to the notifications queue today (the only consumer, Stage 17). */
  readonly #queue: Pick<Queue, 'add'>;

  constructor(db: PrismaClient, queue: Pick<Queue, 'add'>) {
    this.#db = db;
    this.#queue = queue;
  }

  /**
   * One batch, oldest first, in one transaction: lock unpublished rows (`SKIP LOCKED`, so a
   * second relay running at the same time takes other rows instead of waiting), count the
   * attempt, queue each event, and mark published only the ones the queue accepted.
   */
  async relay(batchSize = OUTBOX_BATCH_SIZE): Promise<RelayResult> {
    return this.#db.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedEvent[]>`
        SELECT id, event_type AS "eventType", aggregate_type AS "aggregateType",
               aggregate_id AS "aggregateId", payload, created_at AS "createdAt"
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at, id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;
      if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const ids = claimed.map((event) => event.id);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: { attempts: { increment: 1 } },
      });

      const published: string[] = [];
      for (const event of claimed) {
        const data: OutboxJobData = {
          outboxEventId: event.id,
          eventType: event.eventType,
          aggregate: { type: event.aggregateType, id: event.aggregateId },
          payload: event.payload,
          createdAt: event.createdAt.toISOString(),
        };
        try {
          await this.#queue.add('send-notification', data, { jobId: event.id });
          published.push(event.id);
        } catch {
          // Left unpublished; the next run tries again (the attempt is counted).
        }
      }
      if (published.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: published } },
          data: { publishedAt: new Date() },
        });
      }
      return {
        claimed: claimed.length,
        published: published.length,
        failed: claimed.length - published.length,
      };
    });
  }
}
