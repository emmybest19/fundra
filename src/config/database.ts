// Prisma client singleton and connection lifecycle.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from './env.ts';
import { logger } from './logger.ts';

export interface DatabaseOptions {
  connectionString: string;
  /** Pool size per process. API and worker each have their own pool. */
  maxConnections?: number;
}

export function createPrismaClient({
  connectionString,
  maxConnections = 10,
}: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: maxConnections,
    // Fail fast instead of hanging requests (and readiness checks) when the database is down.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  // Query logging stays off: SQL parameters can contain personal data.
  // Prisma's `error` events are not logged either: every query error is also thrown, and is
  // logged once where it is handled (error middleware, readiness check). Logging both doubled
  // every failure.
  const client = new PrismaClient({
    adapter,
    log: [{ emit: 'event', level: 'warn' }],
  });
  client.$on('warn', (event) => {
    logger.warn({ prisma: event.message, target: event.target }, 'prisma warning');
  });

  return client;
}

/** Shared client. Prisma connects lazily on the first query. */
export const prisma = createPrismaClient({ connectionString: env.DATABASE_URL });

/** Readiness probe: resolves only if the database answers a trivial query. */
export async function checkDatabase(client: PrismaClient = prisma): Promise<void> {
  await client.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(client: PrismaClient = prisma): Promise<void> {
  await client.$disconnect();
}
