// End-to-end harness: the real app on a real PostgreSQL 18 engine (PGlite, in process, every
// migration applied, the real seed), with in-memory Redis-side stores and mock providers.
// Queues record jobs; `drain()` runs them through the real worker handlers, as the worker
// process would. Testcontainers (real PostgreSQL + Redis servers) replaces this once Docker
// is available; nothing in the tests depends on which.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Express } from 'express';
import { seed } from '../../prisma/seed.ts';
import { createApp } from '../../src/app.ts';
import { createPrismaClient } from '../../src/config/database.ts';
import { createLogger } from '../../src/config/logger.ts';
import type { PrismaClient } from '../../src/generated/prisma/client.ts';
import { createJobHandlers, type JobHandlers } from '../../src/jobs/workers.ts';
import { MemoryRateLimitStore } from '../../src/middleware/rate-limit.middleware.ts';
import { MemoryOtpStore } from '../../src/modules/auth/otp.ts';
import { HealthService } from '../../src/modules/health/health.service.ts';
import { MemoryDocumentStorage } from '../../src/modules/kyc/document-storage.ts';
import { MockKycProvider } from '../../src/modules/kyc/providers/mock-kyc-provider.ts';
import { MemoryChannelSenders } from '../../src/modules/notifications/channel-senders.ts';
import { MemoryMessageSender } from '../../src/modules/notifications/notification.service.ts';
import { MockPaymentProvider } from '../../src/modules/payments/providers/mock-payment-provider.ts';

const MIGRATIONS = join(import.meta.dirname, '../../prisma/migrations');
const WEBHOOK_SECRET = 'test-only-payment-webhook-secret-not-for-production';

interface QueuedJob {
  name: string;
  data: unknown;
  opts: { jobId?: string };
}

/** A queue that only records; jobs run when the test drains them, outside any transaction. */
class RecordingQueue {
  readonly jobs: QueuedJob[] = [];
  readonly #ids = new Set<string>();

  add(name: string, data: unknown, opts: { jobId?: string } = {}) {
    // Same job ID = same job, as in BullMQ.
    if (opts.jobId !== undefined) {
      if (this.#ids.has(opts.jobId)) return Promise.resolve({ id: opts.jobId });
      this.#ids.add(opts.jobId);
    }
    this.jobs.push({ name, data, opts });
    return Promise.resolve({ id: opts.jobId ?? String(this.jobs.length) });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

export interface E2e {
  app: Express;
  db: PrismaClient;
  provider: MockPaymentProvider;
  /** One-time codes and direct security messages. */
  messages: MemoryMessageSender;
  /** What the notification channels "sent". */
  channels: MemoryChannelSenders;
  /** Runs every queued job, and the outbox relay, until nothing is left (a worker tick). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function startE2e(): Promise<E2e> {
  const pg = await PGlite.create();
  for (const dir of readdirSync(MIGRATIONS)
    .filter((d) => /^\d{14}_/.test(d))
    .sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();

  // A small pool, like the app's. The socket server must allow at least that many connections
  // (its default is lower, and extra ones are dropped). The journey runs one step at a time, so
  // connections never interleave on PGlite's single session.
  const db = createPrismaClient({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${String(port)}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await seed(db);

  const provider = new MockPaymentProvider({ webhookSecret: WEBHOOK_SECRET });
  const messages = new MemoryMessageSender();
  const channels = new MemoryChannelSenders();
  const statementStorage = new MemoryDocumentStorage();
  const queues = {
    notifications: new RecordingQueue(),
    webhooks: new RecordingQueue(),
    maintenance: new RecordingQueue(),
  };
  const handlers: JobHandlers = createJobHandlers({
    db,
    provider,
    queues: queues as never,
    senders: channels,
    statementStorage,
    logger: createLogger({ level: 'silent', pretty: false }),
  });

  const app = createApp({
    db,
    health: new HealthService([]),
    rateLimitStore: new MemoryRateLimitStore(),
    otpStore: new MemoryOtpStore(),
    messageSender: messages,
    kycProvider: new MockKycProvider(),
    documentStorage: new MemoryDocumentStorage(),
    paymentProvider: provider,
    webhookQueue: queues.webhooks as never,
    maintenanceQueue: queues.maintenance as never,
    statementStorage,
  });

  async function drain(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const relayed = (await handlers['outbox-relay']?.({ data: {} } as never)) as {
        claimed: number;
      };
      const pending = Object.values(queues).flatMap((queue) => queue.jobs.splice(0));
      if (pending.length === 0 && relayed.claimed === 0) return;
      for (const job of pending) {
        const handler = handlers[job.name as keyof JobHandlers];
        if (handler === undefined) throw new Error(`No handler for ${job.name}`);
        await handler({
          name: job.name,
          data: job.data,
          attemptsMade: 0,
          opts: { attempts: 1, ...job.opts },
        } as never);
      }
    }
    throw new Error('Jobs kept producing jobs: drain gave up after 50 rounds');
  }

  return {
    app,
    db,
    provider,
    messages,
    channels,
    drain,
    close: async () => {
      await db.$disconnect();
      await server.stop();
      await pg.close();
    },
  };
}
