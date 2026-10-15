// Worker process entry point: starts all workers (`npm run start:worker`). Runs the jobs the
// API hands off (process-webhook) and the recurring maintenance (docs/ARCHITECTURE.md §9.2).
import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { registerShutdown } from '../common/utils/shutdown.ts';
import { disconnectDatabase, prisma } from '../config/database.ts';
import { env } from '../config/env.ts';
import { logger } from '../config/logger.ts';
import { createQueueConnection, disconnectRedis } from '../config/redis.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import type { PaymentProvider } from '../modules/payments/providers/payment-provider.ts';
import { MockPaymentProvider } from '../modules/payments/providers/mock-payment-provider.ts';
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

/** Jobs run at most this many at a time per queue; maintenance runs one at a time. */
const CONCURRENCY: Readonly<Record<QueueName, number>> = {
  notifications: 10,
  webhooks: 5,
  maintenance: 1,
};

export function createJobHandlers(deps: {
  db: PrismaClient;
  provider: PaymentProvider;
}): JobHandlers {
  const webhooks = createWebhookProcessor(deps.db, deps.provider);
  return {
    'process-webhook': async (job) => {
      const { webhookEventId } = job.data as ProcessWebhookData;
      if (webhookEventId === undefined) return webhooks.processPending();
      const result = await webhooks.process(webhookEventId);
      // Throwing hands the retry to BullMQ's backoff; the event row counts attempts too.
      if (result.status === 'FAILED')
        throw new Error(result.lastError ?? 'Webhook processing failed');
      return result;
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
}

if (import.meta.main) {
  const connection = createQueueConnection(env.REDIS_URL);
  const queues = createQueues(connection);
  // Only the provider's stateless parts (webhook parsing) are used here.
  const provider = new MockPaymentProvider({ webhookSecret: env.PAYMENT_WEBHOOK_SECRET });
  const running = startWorkers({
    connection,
    handlers: createJobHandlers({ db: prisma, provider }),
    logger,
  });
  await scheduleRecurringJobs(queues);
  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'Fundra worker started');

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
