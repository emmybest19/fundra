import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { createTransferRouter } from '../../../src/modules/transfers/transfer.routes.ts';
import {
  createTransferBody,
  recipientQuery,
} from '../../../src/modules/transfers/transfer.schema.ts';
import type { TransferService } from '../../../src/modules/transfers/transfer.service.ts';
import { computeFee } from '../../../src/modules/transactions/fees.ts';
import { dammCheckDigit } from '../../../src/modules/wallets/account-number.ts';

const ACCOUNT = `123456789${String(dammCheckDigit('123456789'))}`;
const TYPO = `${ACCOUNT.slice(0, 8)}${ACCOUNT[9] ?? ''}${ACCOUNT[8] ?? ''}`; // last two swapped

describe('computeFee (D6)', () => {
  const rule = { flatFee: 0n, percentageBps: 0, minFee: null, maxFee: null };

  it('is zero under the seeded free-transfer rule', () => {
    expect(computeFee(1_000_000n, rule)).toBe(0n);
  });

  it('adds a flat fee and basis points, rounding the fraction of a kobo down', () => {
    // 1.5% of ₦100.01 = 150.015 kobo → 150, plus ₦10 flat
    expect(computeFee(10_001n, { ...rule, flatFee: 1_000n, percentageBps: 150 })).toBe(1_150n);
    expect(computeFee(1n, { ...rule, percentageBps: 9_999 })).toBe(0n);
  });

  it('clamps to the minimum and maximum', () => {
    const capped = { ...rule, percentageBps: 100, minFee: 1_000n, maxFee: 5_000n };
    expect(computeFee(10_000n, capped)).toBe(1_000n); // 1% = 100 → min 1,000
    expect(computeFee(10_000_000n, capped)).toBe(5_000n); // 1% = 100,000 → max 5,000
    expect(computeFee(300_000n, capped)).toBe(3_000n);
  });
});

describe('createTransferBody', () => {
  const base = { amount: '1000000', currency: 'NGN' };

  it('takes exactly one of handle or account number', () => {
    expect(
      createTransferBody.safeParse({ ...base, recipientHandle: '@Bola' }).data?.recipientHandle,
    ).toBe('bola');
    expect(createTransferBody.safeParse({ ...base, recipientAccountNumber: ACCOUNT }).success).toBe(
      true,
    );
    expect(createTransferBody.safeParse(base).success).toBe(false);
    expect(
      createTransferBody.safeParse({
        ...base,
        recipientHandle: 'bola',
        recipientAccountNumber: ACCOUNT,
      }).success,
    ).toBe(false);
  });

  it('refuses an account number with a typo before any lookup', () => {
    const result = createTransferBody.safeParse({ ...base, recipientAccountNumber: TYPO });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/typo/);
  });

  it('takes amounts only as positive kobo strings (D1)', () => {
    for (const amount of ['0', '-5', '10.5', '1e6', 1_000_000, '0100']) {
      expect(
        createTransferBody.safeParse({ ...base, amount, recipientHandle: 'bola' }).success,
        String(amount),
      ).toBe(false);
    }
    expect(createTransferBody.parse({ ...base, recipientHandle: 'bola' }).amount).toBe(1_000_000n);
  });

  it('refuses unknown fields (e.g. a fee or sender chosen by the client)', () => {
    expect(
      createTransferBody.safeParse({ ...base, recipientHandle: 'bola', fee: '0' }).success,
    ).toBe(false);
    expect(
      createTransferBody.safeParse({ ...base, recipientHandle: 'bola', fromUserId: 'x' }).success,
    ).toBe(false);
  });
});

describe('recipientQuery', () => {
  it('takes one of handle or accountNumber; currency defaults to NGN', () => {
    expect(recipientQuery.parse({ handle: 'bola' })).toEqual({ handle: 'bola', currency: 'NGN' });
    expect(recipientQuery.safeParse({}).success).toBe(false);
    expect(recipientQuery.safeParse({ accountNumber: TYPO }).success).toBe(false);
  });
});

describe('transfers router', () => {
  const fakeAuthenticate: RequestHandler = (req, res, next) => {
    const userId = req.get('x-test-user');
    if (userId === undefined) {
      res.status(401).json({});
      return;
    }
    const status =
      req.get('x-test-status') === 'PENDING_VERIFICATION' ? 'PENDING_VERIFICATION' : 'ACTIVE';
    req.auth = { userId, sessionId: 's', roles: ['USER'], status };
    next();
  };
  function setup() {
    const transfers = {
      lookupRecipient: vi.fn().mockResolvedValue({ name: 'Bola Test', handle: 'bola' }),
      create: vi.fn().mockResolvedValue({
        status: 201,
        body: { data: { transfer: { id: 't' } } },
        replayed: false,
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/transfers',
      createTransferRouter({
        transfers: transfers as unknown as TransferService,
        authenticate: fakeAuthenticate,
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    );
    app.use(errorHandler);
    return { app, transfers };
  }
  const body = { recipientHandle: 'bola', amount: '1000', currency: 'NGN' };

  it('needs a verified account', async () => {
    const { app, transfers } = setup();
    const res = await request(app)
      .post('/transfers')
      .set('X-Test-User', 'u')
      .set('X-Test-Status', 'PENDING_VERIFICATION')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(transfers.create).not.toHaveBeenCalled();
  });

  it('needs an Idempotency-Key: 400 before anything runs', async () => {
    const { app, transfers } = setup();
    const res = await request(app).post('/transfers').set('X-Test-User', 'u').send(body);
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(transfers.create).not.toHaveBeenCalled();
  });

  it('answers 201, never cached; a replay is marked Idempotent-Replayed', async () => {
    const { app, transfers } = setup();
    const first = await request(app)
      .post('/transfers')
      .set('X-Test-User', 'u')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(transfers.create).toHaveBeenCalledWith(
      'u',
      expect.objectContaining({ amount: 1000n }),
      expect.objectContaining({ key: 'key-12345678' }),
      expect.anything(),
    );

    transfers.create.mockResolvedValueOnce({ status: 201, body: { data: {} }, replayed: true });
    const replay = await request(app)
      .post('/transfers')
      .set('X-Test-User', 'u')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('looks up a recipient by name only', async () => {
    const { app } = setup();
    const res = await request(app).get('/transfers/recipient?handle=bola').set('X-Test-User', 'u');
    expect(res.body).toEqual({ data: { recipient: { name: 'Bola Test', handle: 'bola' } } });
  });
});
