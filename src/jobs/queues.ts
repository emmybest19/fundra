// BullMQ queue definitions and job names (docs/ARCHITECTURE.md §9.2).
import { Queue, type ConnectionOptions, type DefaultJobOptions } from 'bullmq';

export const QUEUE_NAMES = {
  notifications: 'notifications',
  webhooks: 'webhooks',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every job, by the queue that runs it. A job's name is how the worker picks its handler. */
export const JOB_NAMES = {
  notifications: ['send-email', 'send-sms', 'send-push', 'send-notification'],
  webhooks: ['process-webhook'],
  maintenance: [
    'outbox-relay',
    'expire-otp',
    'requeue-notifications',
    'reconcile-transactions',
    'generate-statement',
  ],
} as const satisfies Record<QueueName, readonly string[]>;

export type JobName = (typeof JOB_NAMES)[QueueName][number];

/** `process-webhook`: one stored event by ID, or (no ID) a sweep of everything pending. */
export interface ProcessWebhookData {
  webhookEventId?: string;
}

/**
 * Bounded retries with exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s). Completed jobs are
 * kept a day, so a repeated job ID inside that window is still deduplicated; failed jobs a
 * week, for inspection.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface JobQueues {
  notifications: Queue;
  webhooks: Queue;
  maintenance: Queue;
  /** Closes every queue's connections; in shutdown, before Redis itself. */
  close(): Promise<void>;
}

/**
 * The queues, for adding jobs (the API) or scheduling them (the worker). `connection` is a
 * BullMQ connection: an ioredis client from createQueueConnection in production.
 */
export function createQueues(connection: ConnectionOptions): JobQueues {
  const make = (name: QueueName) =>
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  const queues = {
    notifications: make(QUEUE_NAMES.notifications),
    webhooks: make(QUEUE_NAMES.webhooks),
    maintenance: make(QUEUE_NAMES.maintenance),
  };
  return {
    ...queues,
    close: async () => {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
    },
  };
}
