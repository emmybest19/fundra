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
import request from 'supertest';
import { seed } from '../../prisma/seed.ts';
import { createApp } from '../../src/app.ts';
import { createPrismaClient } from '../../src/config/database.ts';
import { createLogger } from '../../src/config/logger.ts';
import type { PrismaClient } from '../../src/generated/prisma/client.ts';
import { createJobHandlers, type JobHandlers } from '../../src/jobs/workers.ts';
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

export interface Customer {
  id: string;
  handle: string;
  email: string;
  phone: string;
  password: string;
  token: string;
  refreshToken: string;
  walletId: string;
  accountNumber: string;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

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
  /** A request to `/api/v1<path>`, signed in as `who` if given. */
  api(method: Method, path: string, who?: Customer): request.Test;
  /** A verified customer (email and phone), with KYC Tier 1 (a wallet) unless told otherwise. */
  signUp(
    name: string,
    options?: { tier1?: boolean; role?: string; verify?: boolean },
  ): Promise<Customer>;
  /** Posts the provider's signed webhook for a payment, then runs the worker's jobs. */
  settle(
    transactionId: string,
    overrides?: { outcome?: 'SUCCEEDED' | 'FAILED'; amount?: bigint },
  ): Promise<request.Response>;
  /** Posts any signed webhook (e.g. a refund) and runs the worker's jobs. */
  deliver(webhook: {
    rawBody: Buffer;
    headers: Record<string, unknown>;
  }): Promise<request.Response>;
  /** Deposits and completes it: the wallet ends `amount` kobo richer. */
  fund(who: Customer, amount: bigint): Promise<void>;
  close(): Promise<void>;
}

/**
 * `asAppRole`: after migrations and the seed (as the owner), apply prisma/sql/app-role.sql and
 * switch the session to fundra_app, so the whole app runs with production's privileges.
 * (PGlite serves every connection from one session, so one SET ROLE covers them all.)
 */
export async function startE2e(options: { asAppRole?: boolean } = {}): Promise<E2e> {
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
  if (options.asAppRole === true) {
    await pg.exec(readFileSync(join(import.meta.dirname, '../../prisma/sql/app-role.sql'), 'utf8'));
    await pg.exec('SET ROLE fundra_app');
  }

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
    // Never throttles: a journey makes many calls from one IP, and rate limits have their own tests.
    rateLimitStore: { hit: () => Promise.resolve({ count: 1, resetMs: 60_000 }) },
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

  let phones = 0;
  const run = Math.random().toString(36).slice(2, 6);
  const api = (method: Method, path: string, who?: Customer) => {
    const req = request(app)[method](`/api/v1${path}`);
    return who === undefined ? req : req.set('Authorization', `Bearer ${who.token}`);
  };

  async function signUp(
    name: string,
    options: { tier1?: boolean; role?: string; verify?: boolean } = {},
  ): Promise<Customer> {
    const handle = `${name}_${run}`;
    const email = `${handle}@fundra.dev`;
    const password = 'purple elephant 42 tall';
    phones += 1;
    const reg = await api('post', '/auth/register').send({
      email,
      phone: `0803${String(1_000_000 + phones)}`,
      handle,
      firstName: name.charAt(0).toUpperCase() + name.slice(1),
      lastName: 'Test',
      password,
    });
    if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
    const user = (reg.body as { data: { user: { id: string; phone: string } } }).data.user;
    if (options.role !== undefined) {
      const role = await db.role.findUniqueOrThrow({ where: { name: options.role } });
      await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
    const login = await api('post', '/auth/login').send({ identifier: email, password });
    const tokens = (login.body as { data: { accessToken: string; refreshToken: string } }).data;
    const customer: Customer = {
      id: user.id,
      handle,
      email,
      phone: user.phone,
      password,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      walletId: '',
      accountNumber: '',
    };
    if (options.verify !== false) {
      for (const [channel, to] of [
        ['email', email],
        ['phone', user.phone],
      ] as const) {
        await api('post', `/auth/verify/${channel}/request`, customer);
        const confirmed = await api('post', `/auth/verify/${channel}/confirm`, customer).send({
          code: messages.lastCodeTo(to),
        });
        if (confirmed.status !== 200) {
          throw new Error(`verify ${channel} failed: ${JSON.stringify(confirmed.body)}`);
        }
      }
    }
    if (options.tier1 !== false && options.verify !== false) {
      const tier1 = await api('post', '/kyc/tier-1', customer).send({ dateOfBirth: '1990-01-01' });
      if (tier1.status !== 200) throw new Error(`KYC Tier 1 failed: ${JSON.stringify(tier1.body)}`);
      const wallet = await db.wallet.findFirstOrThrow({ where: { userId: user.id } });
      customer.walletId = wallet.id;
      customer.accountNumber = wallet.accountNumber;
    }
    return customer;
  }

  async function deliver(webhook: { rawBody: Buffer; headers: Record<string, unknown> }) {
    let req = request(app).post('/api/v1/webhooks/payments');
    for (const [name, value] of Object.entries(webhook.headers)) req = req.set(name, String(value));
    const res = await req.send(webhook.rawBody.toString('utf8'));
    await drain();
    return res;
  }

  async function settle(
    transactionId: string,
    overrides: { outcome?: 'SUCCEEDED' | 'FAILED'; amount?: bigint } = {},
  ) {
    const payment = await db.payment.findUniqueOrThrow({ where: { transactionId } });
    return deliver(provider.settle(payment.providerReference ?? '', overrides));
  }

  async function fund(who: Customer, amount: bigint) {
    const res = await api('post', '/payments/deposits', who)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ amount: amount.toString(), currency: 'NGN' });
    await settle((res.body as { data: { deposit: { id: string } } }).data.deposit.id);
  }

  return {
    app,
    db,
    provider,
    messages,
    channels,
    drain,
    api,
    signUp,
    settle,
    deliver,
    fund,
    close: async () => {
      await db.$disconnect();
      await server.stop();
      await pg.close();
    },
  };
}
