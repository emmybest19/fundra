import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { createBeneficiaryRouter } from '../../../src/modules/beneficiaries/beneficiary.routes.ts';
import {
  createBeneficiaryBody,
  updateBeneficiaryBody,
} from '../../../src/modules/beneficiaries/beneficiary.schema.ts';
import type { BeneficiaryService } from '../../../src/modules/beneficiaries/beneficiary.service.ts';
import { dammCheckDigit } from '../../../src/modules/wallets/account-number.ts';

const ACCOUNT = `123456789${String(dammCheckDigit('123456789'))}`;
const ID = '01a1407d-89c4-7fff-9ad3-9b767ad1c8c6';

describe('createBeneficiaryBody', () => {
  it('takes a Fundra recipient by exactly one of handle or account number', () => {
    expect(
      createBeneficiaryBody.parse({ type: 'FUNDRA_WALLET', recipientHandle: '@Bola' }),
    ).toEqual({
      type: 'FUNDRA_WALLET',
      recipientHandle: 'bola',
      currency: 'NGN',
    });
    expect(
      createBeneficiaryBody.safeParse({ type: 'FUNDRA_WALLET', recipientAccountNumber: ACCOUNT })
        .success,
    ).toBe(true);
    expect(createBeneficiaryBody.safeParse({ type: 'FUNDRA_WALLET' }).success).toBe(false);
    expect(
      createBeneficiaryBody.safeParse({
        type: 'FUNDRA_WALLET',
        recipientHandle: 'bola',
        recipientAccountNumber: ACCOUNT,
      }).success,
    ).toBe(false);
  });

  it('takes a bank account by bank code and NUBAN, never a name from the client', () => {
    const bank = { type: 'BANK_ACCOUNT', bankCode: '058', accountNumber: '0123456789' };
    expect(createBeneficiaryBody.parse({ ...bank, nickname: ' Rent ' })).toEqual({
      ...bank,
      nickname: 'Rent',
    });
    expect(createBeneficiaryBody.safeParse({ ...bank, accountName: 'ADA' }).success).toBe(false);
    expect(createBeneficiaryBody.safeParse({ ...bank, accountNumber: '123' }).success).toBe(false);
    expect(createBeneficiaryBody.safeParse({ ...bank, type: 'CARD' }).success).toBe(false);
  });

  it('keeps nicknames to 1–50 characters', () => {
    const base = { type: 'FUNDRA_WALLET', recipientHandle: 'bola' };
    expect(createBeneficiaryBody.safeParse({ ...base, nickname: '  ' }).success).toBe(false);
    expect(createBeneficiaryBody.safeParse({ ...base, nickname: 'x'.repeat(51) }).success).toBe(
      false,
    );
  });
});

describe('updateBeneficiaryBody', () => {
  it('changes the nickname only (null clears it); never who the beneficiary is', () => {
    expect(updateBeneficiaryBody.parse({ nickname: null })).toEqual({ nickname: null });
    expect(updateBeneficiaryBody.parse({ nickname: 'Mum' })).toEqual({ nickname: 'Mum' });
    expect(updateBeneficiaryBody.safeParse({ nickname: 'Mum', bankCode: '058' }).success).toBe(
      false,
    );
    expect(updateBeneficiaryBody.safeParse({ recipientHandle: 'eve' }).success).toBe(false);
  });
});

describe('beneficiaries router', () => {
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
    const beneficiaries = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: ID }),
      create: vi.fn().mockResolvedValue({ id: ID }),
      update: vi.fn().mockResolvedValue({ id: ID, nickname: 'Mum' }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const app = express();
    app.use(express.json());
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/beneficiaries',
      createBeneficiaryRouter({
        beneficiaries: beneficiaries as unknown as BeneficiaryService,
        authenticate: fakeAuthenticate,
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    );
    app.use(errorHandler);
    return { app, beneficiaries };
  }
  const body = { type: 'FUNDRA_WALLET', recipientHandle: 'bola' };

  it('saving needs a verified account; listing does not', async () => {
    const { app, beneficiaries } = setup();
    const res = await request(app)
      .post('/beneficiaries')
      .set('X-Test-User', 'u')
      .set('X-Test-Status', 'PENDING_VERIFICATION')
      .send(body);
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(beneficiaries.create).not.toHaveBeenCalled();
    const list = await request(app)
      .get('/beneficiaries')
      .set('X-Test-User', 'u')
      .set('X-Test-Status', 'PENDING_VERIFICATION');
    expect(list.status).toBe(200);
  });

  it('creates (201), lists by type, renames, deletes (204): always for the caller, never cached', async () => {
    const { app, beneficiaries } = setup();
    const created = await request(app).post('/beneficiaries').set('X-Test-User', 'u').send(body);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(beneficiaries.create).toHaveBeenCalledWith(
      'u',
      { ...body, currency: 'NGN' },
      expect.anything(),
    );

    await request(app).get('/beneficiaries?type=BANK_ACCOUNT').set('X-Test-User', 'u');
    expect(beneficiaries.list).toHaveBeenCalledWith('u', 'BANK_ACCOUNT');

    await request(app)
      .patch(`/beneficiaries/${ID}`)
      .set('X-Test-User', 'u')
      .send({ nickname: 'Mum' });
    expect(beneficiaries.update).toHaveBeenCalledWith('u', ID, 'Mum', expect.anything());

    const deleted = await request(app).delete(`/beneficiaries/${ID}`).set('X-Test-User', 'u');
    expect(deleted.status).toBe(204);
    expect(beneficiaries.delete).toHaveBeenCalledWith('u', ID, expect.anything());
  });

  it('refuses a malformed ID before the service', async () => {
    const { app, beneficiaries } = setup();
    expect((await request(app).get('/beneficiaries/nope').set('X-Test-User', 'u')).status).toBe(
      422,
    );
    expect(beneficiaries.get).not.toHaveBeenCalled();
  });

  it('allows 30 saves an hour per user, then 429', async () => {
    const { app } = setup();
    for (let i = 0; i < 30; i++) {
      await request(app).post('/beneficiaries').set('X-Test-User', 'u').send(body);
    }
    expect(
      (await request(app).post('/beneficiaries').set('X-Test-User', 'u').send(body)).status,
    ).toBe(429);
  });
});
