import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/common/utils/cursor.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { createTransactionRouter } from '../../../src/modules/transactions/transaction.routes.ts';
import { historyQuery } from '../../../src/modules/transactions/transaction.schema.ts';
import type { TransactionService } from '../../../src/modules/transactions/transaction.service.ts';
import {
  toTransactionView,
  type TransactionWithParties,
} from '../../../src/modules/transactions/transaction.types.ts';

const ID = '0199a0a0-0000-7000-8000-0000000000aa';
const MINE = 'aaaaaaaa-0000-7000-8000-000000000001';
const THEIRS = 'bbbbbbbb-0000-7000-8000-000000000002';

describe('cursor', () => {
  it('round-trips a position to the millisecond', () => {
    const position = { createdAt: new Date('2026-10-14T10:00:00.123Z'), id: ID };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('rejects anything that isn’t one of ours', () => {
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of [
      'not-a-cursor',
      '',
      forged(['2026-10-14T10:00:00.000Z']),
      forged(['2026-10-14T10:00:00.000Z', 'DROP TABLE']),
      forged(['yesterday', ID]),
      forged({ createdAt: '2026-10-14T10:00:00.000Z', id: ID }),
    ]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });
});

describe('historyQuery', () => {
  it('defaults the limit to 20 and caps it at 100', () => {
    expect(historyQuery.parse({}).limit).toBe(20);
    expect(historyQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(historyQuery.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('decodes the cursor, and refuses a bad one', () => {
    const cursor = encodeCursor({ createdAt: new Date('2026-10-14T10:00:00Z'), id: ID });
    expect(historyQuery.parse({ cursor }).cursor?.id).toBe(ID);
    expect(historyQuery.safeParse({ cursor: 'garbage' }).success).toBe(false);
  });

  it('accepts filters, and needs from < to', () => {
    const q = historyQuery.parse({
      type: 'TRANSFER',
      status: 'COMPLETED',
      direction: 'out',
      from: '2026-10-01T00:00:00+01:00',
      to: '2026-10-15T00:00:00Z',
    });
    expect(q.from?.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(
      historyQuery.safeParse({ from: '2026-10-15T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(historyQuery.safeParse({ type: 'GIFT' }).success).toBe(false);
    expect(historyQuery.safeParse({ userId: MINE }).success).toBe(false); // strict
  });
});

describe('toTransactionView', () => {
  const party = (id: string, firstName: string, handle: string) => ({
    id,
    user: { firstName, lastName: 'Okafor', handle },
  });
  const transfer: TransactionWithParties = {
    id: ID,
    reference: 'FND-TRX-20261014-8F92A1',
    type: 'TRANSFER',
    status: 'COMPLETED',
    currency: 'NGN',
    amount: 300_000n,
    fee: 5_000n,
    sourceWalletId: MINE,
    destinationWalletId: THEIRS,
    initiatedByUserId: 'u-me',
    reversalOfId: null,
    description: 'Lunch',
    failureReason: null,
    metadata: {},
    completedAt: new Date('2026-10-14T10:00:01Z'),
    createdAt: new Date('2026-10-14T10:00:00Z'),
    updatedAt: new Date('2026-10-14T10:00:01Z'),
    sourceWallet: party(MINE, 'Emma', 'emma'),
    destinationWallet: party(THEIRS, 'Bola', 'bola'),
    reversalOf: null,
  };

  it('sender sees OUT, the fee, total = amount + fee, and the recipient', () => {
    const view = toTransactionView(transfer, new Set([MINE]), 695_000n);
    expect(view).toMatchObject({
      direction: 'OUT',
      amount: '300000',
      fee: '5000',
      total: '305000',
      counterparty: { name: 'Bola Okafor', handle: 'bola' },
      balanceAfter: '695000',
    });
  });

  it('recipient sees IN, no fee (not theirs), total = amount, and the sender', () => {
    const view = toTransactionView(transfer, new Set([THEIRS]), 300_000n);
    expect(view).toMatchObject({
      direction: 'IN',
      fee: '0',
      total: '300000',
      counterparty: { name: 'Emma Okafor', handle: 'emma' },
    });
  });

  it('shows a failure reason only on the caller’s own outgoing item', () => {
    const failed = { ...transfer, status: 'FAILED' as const, failureReason: 'Insufficient funds' };
    expect(toTransactionView(failed, new Set([MINE]), null).failureReason).toBe(
      'Insufficient funds',
    );
    expect(toTransactionView(failed, new Set([THEIRS]), null).failureReason).toBeNull();
  });

  it('never exposes the other party’s wallet, user or account details', () => {
    const json = JSON.stringify(toTransactionView(transfer, new Set([MINE]), null));
    expect(json).not.toContain(THEIRS);
    expect(json).not.toMatch(/userId|walletId|accountNumber|initiatedBy|metadata/);
  });

  it('has no counterparty for money from outside (a deposit)', () => {
    const deposit = {
      ...transfer,
      type: 'DEPOSIT' as const,
      sourceWalletId: null,
      sourceWallet: null,
      destinationWalletId: MINE,
      destinationWallet: party(MINE, 'Emma', 'emma'),
    };
    expect(toTransactionView(deposit, new Set([MINE]), null)).toMatchObject({
      direction: 'IN',
      counterparty: null,
      balanceAfter: null,
    });
  });
});

describe('transactions router', () => {
  const fakeAuthenticate: RequestHandler = (req, res, next) => {
    const userId = req.get('x-test-user');
    if (userId === undefined) {
      res.status(401).json({});
      return;
    }
    req.auth = { userId, sessionId: 's', roles: ['USER'], status: 'ACTIVE' };
    next();
  };
  function setup() {
    const transactions = {
      list: vi.fn().mockResolvedValue({ transactions: [], nextCursor: 'next' }),
      get: vi.fn().mockResolvedValue({ id: ID }),
    };
    const app = express();
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/transactions',
      createTransactionRouter({
        transactions: transactions as unknown as TransactionService,
        authenticate: fakeAuthenticate,
      }),
    );
    app.use(errorHandler);
    return { app, transactions };
  }

  it('requires authentication', async () => {
    const { app } = setup();
    expect((await request(app).get('/transactions')).status).toBe(401);
    expect((await request(app).get(`/transactions/${ID}`)).status).toBe(401);
  });

  it('lists for the signed-in user with meta.nextCursor, never cached', async () => {
    const { app, transactions } = setup();
    const res = await request(app)
      .get('/transactions?limit=5&type=TRANSFER')
      .set('X-Test-User', 'u-1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: { transactions: [] },
      meta: { limit: 5, nextCursor: 'next' },
    });
    expect(transactions.list).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ limit: 5, type: 'TRANSFER' }),
    );
  });

  it('refuses a bad cursor or filter with 422, without querying', async () => {
    const { app, transactions } = setup();
    expect(
      (await request(app).get('/transactions?cursor=nope').set('X-Test-User', 'u-1')).status,
    ).toBe(422);
    expect(
      (await request(app).get('/transactions?direction=sideways').set('X-Test-User', 'u-1')).status,
    ).toBe(422);
    expect(
      (await request(app).get('/transactions/not-a-uuid').set('X-Test-User', 'u-1')).status,
    ).toBe(422);
    expect(transactions.list).not.toHaveBeenCalled();
    expect(transactions.get).not.toHaveBeenCalled();
  });
});
