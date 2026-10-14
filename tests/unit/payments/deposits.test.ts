import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import type { DepositService } from '../../../src/modules/payments/deposit.service.ts';
import { createDepositBody } from '../../../src/modules/payments/payment.schema.ts';
import { createPaymentRouter } from '../../../src/modules/payments/payment.routes.ts';

describe('createDepositBody', () => {
  it('takes a positive kobo string and a currency', () => {
    expect(createDepositBody.parse({ amount: '500000', currency: 'NGN' })).toEqual({
      amount: 500_000n,
      currency: 'NGN',
    });
  });

  it('refuses other amounts, other currencies and unknown fields', () => {
    for (const amount of ['0', '-5', '10.5', 500000, '1e6']) {
      expect(createDepositBody.safeParse({ amount, currency: 'NGN' }).success, String(amount)).toBe(
        false,
      );
    }
    expect(createDepositBody.safeParse({ amount: '1', currency: 'USD' }).success).toBe(false);
    expect(
      createDepositBody.safeParse({ amount: '1', currency: 'NGN', walletId: 'x' }).success,
    ).toBe(false);
  });
});

describe('payments router', () => {
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
    const deposits = {
      create: vi.fn().mockResolvedValue({
        status: 201,
        body: { data: { deposit: { id: 't' }, checkoutUrl: 'https://x.invalid/pay' } },
        replayed: false,
      }),
    };
    const app = express();
    app.use(express.json());
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/payments',
      createPaymentRouter({
        deposits: deposits as unknown as DepositService,
        authenticate: fakeAuthenticate,
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    );
    app.use(errorHandler);
    return { app, deposits };
  }
  const body = { amount: '500000', currency: 'NGN' };

  it('needs a verified account', async () => {
    const { app, deposits } = setup();
    const res = await request(app)
      .post('/payments/deposits')
      .set('X-Test-User', 'u')
      .set('X-Test-Status', 'PENDING_VERIFICATION')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(deposits.create).not.toHaveBeenCalled();
  });

  it('needs an Idempotency-Key: 400 before anything runs', async () => {
    const { app, deposits } = setup();
    const res = await request(app).post('/payments/deposits').set('X-Test-User', 'u').send(body);
    expect(res.status).toBe(400);
    expect((res.body as ApiErrorBody).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(deposits.create).not.toHaveBeenCalled();
  });

  it('answers 201, never cached; a replay is marked Idempotent-Replayed', async () => {
    const { app, deposits } = setup();
    const first = await request(app)
      .post('/payments/deposits')
      .set('X-Test-User', 'u')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(deposits.create).toHaveBeenCalledWith(
      'u',
      { amount: 500_000n, currency: 'NGN' },
      expect.objectContaining({ key: 'key-12345678' }),
      expect.anything(),
    );

    deposits.create.mockResolvedValueOnce({ status: 201, body: { data: {} }, replayed: true });
    const replay = await request(app)
      .post('/payments/deposits')
      .set('X-Test-User', 'u')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('allows 10 deposits a minute per user, then 429', async () => {
    const { app } = setup();
    const send = (key: string) =>
      request(app)
        .post('/payments/deposits')
        .set('X-Test-User', 'u')
        .set('Idempotency-Key', key)
        .send(body);
    for (let i = 0; i < 10; i++) expect((await send(`key-0000000${String(i)}`)).status).toBe(201);
    expect((await send('key-00000010')).status).toBe(429);
  });
});
