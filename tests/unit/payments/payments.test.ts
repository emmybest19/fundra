import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import type { DepositService } from '../../../src/modules/payments/deposit.service.ts';
import {
  bankAccountQuery,
  createBillPaymentBody,
  createDepositBody,
  createWithdrawalBody,
} from '../../../src/modules/payments/payment.schema.ts';
import { createPaymentRouter } from '../../../src/modules/payments/payment.routes.ts';
import {
  maskAccountNumber,
  type OutboundPaymentService,
} from '../../../src/modules/payments/outbound-payment.service.ts';

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

describe('createWithdrawalBody and bankAccountQuery', () => {
  const base = { bankCode: '058', accountNumber: '0123456789', amount: '250000', currency: 'NGN' };

  it('takes a bank code, a 10-digit account number, the amount and an optional description', () => {
    expect(createWithdrawalBody.parse({ ...base, description: ' Rent ' })).toEqual({
      ...base,
      amount: 250_000n,
      description: 'Rent',
    });
    expect(bankAccountQuery.parse({ bankCode: ' 058 ', accountNumber: '0123456789' })).toEqual({
      bankCode: '058',
      accountNumber: '0123456789',
    });
  });

  it.each([
    ['a short account number', { accountNumber: '012345678' }],
    ['letters in the account number', { accountNumber: '01234567AB' }],
    ['a bank name for a code', { bankCode: 'GTB' }],
    ['a zero amount', { amount: '0' }],
    ['a numeric amount', { amount: 250000 }],
    ['a description over 100 characters', { description: 'x'.repeat(101) }],
    ['an account name from the client', { accountName: 'ADA OKAFOR' }],
    ['a fee from the client', { fee: '0' }],
  ])('refuses %s', (_label, change) => {
    expect(createWithdrawalBody.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

describe('createBillPaymentBody', () => {
  const base = {
    billerCode: 'DSTV',
    customerReference: '1234567890',
    amount: '150000',
    currency: 'NGN',
  };

  it('takes a biller code, a customer reference and the amount', () => {
    expect(createBillPaymentBody.parse(base)).toEqual({ ...base, amount: 150_000n });
  });

  it.each([
    ['a lower-case biller code', { billerCode: 'dstv' }],
    ['a customer reference with spaces', { customerReference: '1234 5678' }],
    ['a too-short customer reference', { customerReference: '123' }],
    ['a zero amount', { amount: '0' }],
    ['a fee from the client', { fee: '0' }],
  ])('refuses %s', (_label, change) => {
    expect(createBillPaymentBody.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

describe('maskAccountNumber', () => {
  it('shows only the last four digits', () => {
    expect(maskAccountNumber('0123456789')).toBe('******6789');
    expect(maskAccountNumber('123')).toBe('123');
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
    const outbound = {
      withdraw: vi.fn().mockResolvedValue({
        status: 201,
        body: { data: { withdrawal: { id: 'w' } } },
        replayed: false,
      }),
      payBill: vi.fn().mockResolvedValue({
        status: 201,
        body: { data: { payment: { id: 'p' } } },
        replayed: false,
      }),
      listBillers: vi.fn().mockResolvedValue([{ code: 'DSTV', name: 'DStv' }]),
      resolveBankAccount: vi.fn().mockResolvedValue({
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'ADA OKAFOR',
      }),
    };
    app.use(express.json());
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/payments',
      createPaymentRouter({
        deposits: deposits as unknown as DepositService,
        outbound: outbound as unknown as OutboundPaymentService,
        authenticate: fakeAuthenticate,
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    );
    app.use(errorHandler);
    return { app, deposits, outbound };
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

  it('withdraws with an Idempotency-Key, passing the parsed body', async () => {
    const { app, outbound } = setup();
    const send = () =>
      request(app)
        .post('/payments/withdrawals')
        .set('X-Test-User', 'u')
        .send({ bankCode: '058', accountNumber: '0123456789', amount: '250000', currency: 'NGN' });

    expect((await send()).status).toBe(400);
    expect(outbound.withdraw).not.toHaveBeenCalled();
    const res = await send().set('Idempotency-Key', 'key-12345678');
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(outbound.withdraw).toHaveBeenCalledWith(
      'u',
      { bankCode: '058', accountNumber: '0123456789', amount: 250_000n, currency: 'NGN' },
      expect.objectContaining({ key: 'key-12345678' }),
      expect.anything(),
    );
  });

  it('resolves a bank account (name enquiry), 30 an hour per user', async () => {
    const { app } = setup();
    const ask = () =>
      request(app)
        .get('/payments/bank-accounts/resolve?bankCode=058&accountNumber=0123456789')
        .set('X-Test-User', 'u');

    expect((await ask()).body).toEqual({
      data: {
        account: { bankCode: '058', accountNumber: '0123456789', accountName: 'ADA OKAFOR' },
      },
    });
    for (let i = 1; i < 30; i++) await ask();
    expect((await ask()).status).toBe(429);
  });

  it('lists billers, and pays a bill with an Idempotency-Key', async () => {
    const { app, outbound } = setup();
    const billers = await request(app).get('/payments/billers').set('X-Test-User', 'u');
    expect(billers.body).toEqual({ data: { billers: [{ code: 'DSTV', name: 'DStv' }] } });

    const body = {
      billerCode: 'DSTV',
      customerReference: '1234567890',
      amount: '150000',
      currency: 'NGN',
    };
    const noKey = await request(app).post('/payments/bills').set('X-Test-User', 'u').send(body);
    expect(noKey.status).toBe(400);
    const res = await request(app)
      .post('/payments/bills')
      .set('X-Test-User', 'u')
      .set('Idempotency-Key', 'key-12345678')
      .send(body);
    expect(res.status).toBe(201);
    expect(outbound.payBill).toHaveBeenCalledTimes(1);
  });
});
