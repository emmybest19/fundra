// Worker process entry point: starts all workers (`npm run start:worker`). Runs the jobs the
// API hands off (process-webhook) and the recurring maintenance (docs/ARCHITECTURE.md §9.2).
import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { IdempotencyService } from '../common/idempotency/idempotency.service.ts';
import { OutboxRelay, type OutboxJobData } from '../common/outbox/outbox.relay.ts';
import { registerShutdown } from '../common/utils/shutdown.ts';
import { disconnectDatabase, prisma } from '../config/database.ts';
import { env } from '../config/env.ts';
import { logger } from '../config/logger.ts';
import { createQueueConnection, disconnectRedis } from '../config/redis.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import type { PaymentProvider } from '../modules/payments/providers/payment-provider.ts';
import { MockPaymentProvider } from '../modules/payments/providers/mock-payment-provider.ts';
import { MemoryChannelSenders } from '../modules/notifications/channel-senders.ts';
import {
  NotificationService,
  type DeliverNotificationData,
} from '../modules/notifications/notification.service.ts';
import type { ChannelSenders } from '../modules/notifications/notification.types.ts';
import { NotificationDelivery } from '../modules/notifications/notification.worker.ts';
import { createWebhookProcessor } from '../modules/webhooks/webhook.processor.ts';
import {
  createQueues,
  QUEUE_NAMES,
  type JobName,
  type JobQueues,
  type ProcessWebhookData,
  type QueueName,
} from './queues.ts';

export type JobHandler = (job: Job) => Promise<unknown>;
export type JobHandlers = Partial<Record<JobName, JobHandler>>;

/** How often the webhook sweep picks up events that weren't (or couldn't be) processed. */
export const WEBHOOK_SWEEP_EVERY_MS = 30_000;

/** How often notifications stuck in PENDING are queued again. */
export const REQUEUE_NOTIFICATIONS_EVERY_MS = 60_000;

/** How often expired short-lived records are cleared. */
export const EXPIRE_EVERY_MS = 60 * 60 * 1_000;

/** How often committed outbox events are published: the lag before a notification starts. */
export const OUTBOX_RELAY_EVERY_MS = 1_000;

/** Jobs run at most this many at a time per queue; maintenance runs one at a time. */
const CONCURRENCY: Readonly<Record<QueueName, number>> = {
  notifications: 10,
  webhooks: 5,
  maintenance: 1,
};

export function createJobHandlers(deps: {
  db: PrismaClient;
  provider: PaymentProvider;
  queues: Pick<JobQueues, 'notifications'>;
  senders: ChannelSenders;
  logger: Logger;
}): JobHandlers {
  const webhooks = createWebhookProcessor(deps.db, deps.provider);
  const outbox = new OutboxRelay(deps.db, deps.queues.notifications);
  const idempotency = new IdempotencyService(deps.db);
  const notifications = new NotificationService(deps.db, deps.queues.notifications);
  const delivery = new NotificationDelivery(deps.db, deps.senders);
  // The last attempt marks the notification FAILED before the error is rethrown.
  const deliver = (job: Job) =>
    delivery.deliver((job.data as DeliverNotificationData).notificationId, {
      final: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
    });
  return {
    'process-webhook': async (job) => {
      const { webhookEventId } = job.data as ProcessWebhookData;
      if (webhookEventId === undefined) return webhooks.processPending();
      const result = await webhooks.process(webhookEventId);
      // Throwing hands the retry to BullMQ's backoff; the event row counts attempts too.
      if (result.status === 'FAILED') {
        throw new Error(result.lastError ?? 'Webhook processing failed');
      }
      return result;
    },
    'outbox-relay': () => outbox.relay(),
    // One-time codes need nothing here: they live in Redis and expire by TTL (set atomically
    // with the code). What does pile up is expired idempotency keys in PostgreSQL.
    'expire-otp': async () => ({ idempotencyKeysDeleted: await idempotency.purgeExpired() }),
    'send-email': deliver,
    'send-sms': deliver,
    'send-push': deliver,
    'requeue-notifications': async () => ({ queued: await notifications.requeuePending() }),
    // Stage 17 replaces this with real notifications. Until then the published events are
    // acknowledged here, so they don't pile up as failed jobs.
    'send-notification': (job) => {
      const { outboxEventId, eventType } = job.data as OutboxJobData;
      deps.logger.debug(
        { outboxEventId, eventType },
        'notification not sent: notifications arrive in Stage 17',
      );
      return Promise.resolve({ sent: false });
    },
  };
}

export interface RunningWorkers {
  workers: readonly Worker[];
  /** Stops taking jobs and waits for the ones running to finish. */
  close(): Promise<void>;
}

/** One worker per queue, each dispatching by job name. A job with no handler fails for good. */
export function startWorkers(options: {
  connection: ConnectionOptions;
  handlers: JobHandlers;
  logger: Logger;
}): RunningWorkers {
  const { connection, handlers, logger: log } = options;
  const workers = Object.values(QUEUE_NAMES).map((queue) => {
    const worker = new Worker(
      queue,
      async (job) => {
        const handler = handlers[job.name as JobName];
        if (handler === undefined) throw new UnrecoverableError(`No handler for job ${job.name}`);
        return handler(job);
      },
      { connection, concurrency: CONCURRENCY[queue] },
    );
    worker.on('failed', (job, err) => {
      log.warn(
        { queue, job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err },
        'job failed',
      );
    });
    worker.on('error', (err) => {
      log.error({ queue, err }, 'worker error');
    });
    return worker;
  });
  return {
    workers,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}

/** Recurring jobs. Upserted on every start, so changing an interval needs only a redeploy. */
export async function scheduleRecurringJobs(queues: JobQueues): Promise<void> {
  await queues.webhooks.upsertJobScheduler(
    'process-webhook-sweep',
    { every: WEBHOOK_SWEEP_EVERY_MS },
    { name: 'process-webhook', data: {} satisfies ProcessWebhookData },
  );
  await queues.maintenance.upsertJobScheduler(
    'outbox-relay',
    { every: OUTBOX_RELAY_EVERY_MS },
    { name: 'outbox-relay', data: {} },
  );
  await queues.maintenance.upsertJobScheduler(
    'expire-otp',
    { every: EXPIRE_EVERY_MS },
    { name: 'expire-otp', data: {} },
  );
  await queues.maintenance.upsertJobScheduler(
    'requeue-notifications',
    { every: REQUEUE_NOTIFICATIONS_EVERY_MS },
    { name: 'requeue-notifications', data: {} },
  );
}

if (import.meta.main) {
  const connection = createQueueConnection(env.REDIS_URL);
  const queues = createQueues(connection);
  // Only the provider's stateless parts (webhook parsing) are used here.
  const provider = new MockPaymentProvider({ webhookSecret: env.PAYMENT_WEBHOOK_SECRET });
  const running = startWorkers({
    connection,
    // Email/SMS/push providers arrive with deployment (Stage 25); until then nothing leaves.
    handlers: createJobHandlers({
      db: prisma,
      provider,
      queues,
      senders: new MemoryChannelSenders(),
      logger,
    }),
    logger,
  });
  await scheduleRecurringJobs(queues);
  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'Fundra worker started');
  logger.warn(
    'Notifications use in-memory email/SMS/push senders: nothing is actually delivered yet',
  );

  registerShutdown({
    logger,
    // Workers first (finish running jobs), then queues, then Redis, then the database.
    cleanup: [
      () => running.close(),
      () => queues.close(),
      () => disconnectRedis(connection),
      () => disconnectDatabase(),
    ],
  });
}
