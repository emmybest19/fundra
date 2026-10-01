import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDatabase,
  createPrismaClient,
  disconnectDatabase,
} from '../../../src/config/database.ts';
import type { PrismaClient } from '../../../src/generated/prisma/client.ts';

// Real-database behaviour is covered by integration tests (Testcontainers, Stage 6).
// These tests only pin down behaviour when the database can't be reached.

let client: PrismaClient | undefined;

afterEach(async () => {
  if (client) await disconnectDatabase(client);
  client = undefined;
});

describe('checkDatabase', () => {
  it('rejects quickly when nothing is listening', async () => {
    // Port 1 is reserved and never runs PostgreSQL.
    client = createPrismaClient({ connectionString: 'postgresql://u:p@127.0.0.1:1/fundra' });
    const started = Date.now();

    await expect(checkDatabase(client)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('createPrismaClient', () => {
  it('does not connect until the first query', () => {
    // Constructing with an unreachable URL must not throw: the app can start and report
    // "database down" through readiness instead of crashing.
    expect(() => {
      client = createPrismaClient({ connectionString: 'postgresql://u:p@127.0.0.1:1/fundra' });
    }).not.toThrow();
  });
});
