import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  classifyDatabaseError,
  isRetryable,
  isUniqueViolation,
  normalizeError,
} from '../../../src/common/errors/index.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';

// Shapes recorded from Prisma 7.10 + @prisma/adapter-pg on PostgreSQL 18.3 (Stage 11 probe).
// The Prisma code depends on the API used; only the SQLSTATE is reliable.

/** A PrismaClientKnownRequestError: the SQLSTATE is under meta.driverAdapterError.cause. */
function prismaError(prismaCode: string, cause: Record<string, unknown>) {
  return Object.assign(new Error('Invalid prisma invocation'), {
    name: 'PrismaClientKnownRequestError',
    code: prismaCode,
    clientVersion: '7.10.0',
    meta: { modelName: 'Wallet', driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

const UNIQUE = prismaError('P2002', {
  originalCode: '23505',
  originalMessage: 'duplicate key value violates unique constraint "users_handle_key"',
  kind: 'UniqueConstraintViolation',
  constraint: { index: 'users_handle_key' },
  table: 'users',
});
const FOREIGN_KEY_RAW = prismaError('P2010', {
  originalCode: '23503',
  originalMessage:
    'insert or update on table "wallets" violates foreign key constraint "wallets_user_id_fkey"',
  kind: 'ForeignKeyConstraintViolation',
  constraint: { index: 'wallets_user_id_fkey' },
});
const CHECK_MODEL = prismaError('P2039', {
  originalCode: '23514',
  originalMessage:
    'new row for relation "wallets" violates check constraint "wallets_available_balance_chk"',
  kind: 'postgres',
  code: '23514',
});
const CHECK_RAW = prismaError('P2010', {
  originalCode: '23514',
  originalMessage:
    'new row for relation "wallets" violates check constraint "wallets_available_balance_chk"',
  kind: 'postgres',
  code: '23514',
});
const APPEND_ONLY = prismaError('P2039', {
  originalCode: 'FN001',
  originalMessage: 'ledger_accounts is append-only: UPDATE is not allowed',
  kind: 'postgres',
  code: 'FN001',
});
/** At COMMIT: a bare DriverAdapterError, no Prisma code, no meta. */
const UNBALANCED_AT_COMMIT = Object.assign(new Error('ledger transaction … is unbalanced'), {
  name: 'DriverAdapterError',
  cause: {
    originalCode: 'FN002',
    originalMessage: 'ledger transaction x is unbalanced: debits 0 <> credits 5',
    kind: 'postgres',
    code: 'FN002',
  },
});
const DEADLOCK = prismaError('P2010', {
  originalCode: '40P01',
  originalMessage: 'deadlock detected',
  kind: 'TransactionWriteConflict',
});
const TX_TIMEOUT = Object.assign(new Error('Transaction API error: expired transaction'), {
  name: 'PrismaClientKnownRequestError',
  code: 'P2028',
  meta: { modelName: 'User', operation: 'count', timeout: 50, timeTaken: 310 },
});

describe('classifyDatabaseError', () => {
  it('classifies by SQLSTATE, whatever the Prisma code', () => {
    expect(classifyDatabaseError(CHECK_MODEL)).toEqual(classifyDatabaseError(CHECK_RAW));
    expect(classifyDatabaseError(CHECK_RAW)).toEqual({
      kind: 'CHECK',
      sqlstate: '23514',
      constraint: 'wallets_available_balance_chk',
      integrity: false,
    });
  });

  it('names the constraint for unique and foreign-key violations', () => {
    expect(classifyDatabaseError(UNIQUE)).toMatchObject({
      kind: 'UNIQUE',
      constraint: 'users_handle_key',
    });
    expect(classifyDatabaseError(FOREIGN_KEY_RAW)).toMatchObject({
      kind: 'FOREIGN_KEY',
      sqlstate: '23503',
      constraint: 'wallets_user_id_fkey',
    });
  });

  it('flags the database protecting the books as an integrity failure', () => {
    expect(classifyDatabaseError(APPEND_ONLY)).toMatchObject({
      kind: 'APPEND_ONLY',
      integrity: true,
    });
    expect(classifyDatabaseError(UNBALANCED_AT_COMMIT)).toEqual({
      kind: 'UNBALANCED_LEDGER',
      sqlstate: 'FN002',
      integrity: true,
    });
  });

  it('reads the bare DriverAdapterError thrown at COMMIT (no code, no meta)', () => {
    expect(UNBALANCED_AT_COMMIT).not.toHaveProperty('code');
    expect(classifyDatabaseError(UNBALANCED_AT_COMMIT)?.kind).toBe('UNBALANCED_LEDGER');
  });

  it('treats deadlocks, serialization failures, lock timeouts and expired transactions as retryable', () => {
    expect(isRetryable(DEADLOCK)).toBe(true);
    expect(isRetryable(TX_TIMEOUT)).toBe(true);
    for (const code of ['40001', '55P03']) {
      expect(isRetryable(prismaError('P2010', { originalCode: code })), code).toBe(true);
    }
    expect(isRetryable(UNIQUE)).toBe(false);
  });

  it('returns null for anything else', () => {
    expect(classifyDatabaseError(new Error('boom'))).toBeNull();
    expect(classifyDatabaseError(null)).toBeNull();
    expect(classifyDatabaseError({ code: 'P2002' })).toBeNull(); // a Prisma code alone proves nothing
    expect(classifyDatabaseError(prismaError('P2010', { originalCode: '42P01' }))).toBeNull();
  });
});

describe('isUniqueViolation', () => {
  it('can require specific constraints', () => {
    expect(isUniqueViolation(UNIQUE)).toBe(true);
    expect(isUniqueViolation(UNIQUE, 'users_handle_key')).toBe(true);
    expect(isUniqueViolation(UNIQUE, 'users_email_key', 'users_phone_key')).toBe(false);
    expect(isUniqueViolation(CHECK_RAW)).toBe(false);
  });
});

describe('normalizeError for untranslated database failures', () => {
  it('retryable → 503 with Retry-After 1', () => {
    const error = normalizeError(DEADLOCK);
    expect([error.statusCode, error.code, error.retryAfterSeconds]).toEqual([
      503,
      'SERVICE_UNAVAILABLE',
      1,
    ]);
  });

  it('unexpected unique violation → 409 CONFLICT with a generic message', () => {
    const error = normalizeError(UNIQUE);
    expect([error.statusCode, error.code]).toEqual([409, 'CONFLICT']);
    expect(error.message).not.toMatch(/users|handle|constraint|duplicate/i);
  });

  it('foreign key, CHECK, append-only and unbalanced → 500', () => {
    for (const err of [FOREIGN_KEY_RAW, CHECK_MODEL, APPEND_ONLY, UNBALANCED_AT_COMMIT]) {
      expect(normalizeError(err).statusCode).toBe(500);
    }
  });
});

describe('error middleware with database failures', () => {
  function appThrowing(err: unknown) {
    const lines: string[] = [];
    const app = express();
    app.use(
      createRequestLogger(
        createLogger(
          { level: 'info', pretty: false },
          { write: (line: string) => lines.push(line) },
        ),
      ),
    );
    app.get('/', () => {
      throw err;
    });
    app.use(errorHandler);
    return { app, lines };
  }

  it('sends Retry-After on a retryable failure', async () => {
    const res = await request(appThrowing(DEADLOCK).app).get('/');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('never sends SQL, tables or constraint names to the client', async () => {
    for (const err of [UNIQUE, FOREIGN_KEY_RAW, CHECK_RAW, APPEND_ONLY, UNBALANCED_AT_COMMIT]) {
      const body = JSON.stringify((await request(appThrowing(err).app).get('/')).body);
      expect(body).not.toMatch(/users_|wallets|ledger|constraint|FN00|23\d\d\d|append-only/);
    }
  });

  it('logs the classification, flagging integrity failures', async () => {
    const { app, lines } = appThrowing(UNBALANCED_AT_COMMIT);
    await request(app).get('/');
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = logged.find((line) => line.msg === 'database error');
    expect(entry?.level).toBe(50);
    expect(entry?.database).toEqual({
      kind: 'UNBALANCED_LEDGER',
      sqlstate: 'FN002',
      integrity: true,
    });
  });
});
