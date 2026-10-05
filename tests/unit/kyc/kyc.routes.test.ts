import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { KYC_DOCUMENT_MAX_BYTES } from '../../../src/modules/kyc/document-file.ts';
import { createKycRouter, IDENTITY_CHECK_RATE_LIMIT } from '../../../src/modules/kyc/kyc.routes.ts';
import type { KycService } from '../../../src/modules/kyc/kyc.service.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** X-Test-User signs in; X-Test-Status sets the account status (default ACTIVE). */
const fakeAuthenticate: RequestHandler = (req, res, next) => {
  const userId = req.get('x-test-user');
  if (userId === undefined) {
    res.status(401).json({ success: false });
    return;
  }
  const status =
    req.get('x-test-status') === 'PENDING_VERIFICATION' ? 'PENDING_VERIFICATION' : 'ACTIVE';
  req.auth = { userId, sessionId: 's-1', roles: ['USER'], status };
  next();
};

function setup() {
  const kyc = {
    getOverview: vi.fn().mockResolvedValue({ tier: 0 }),
    submitTier1: vi.fn().mockResolvedValue({ tier: 1 }),
    submitTier2: vi.fn().mockResolvedValue({ tier: 2 }),
    uploadDocument: vi.fn().mockResolvedValue({ id: 'd-1' }),
    submitTier3: vi.fn().mockResolvedValue({ status: 'PENDING' }),
  };
  const app = express();
  app.use(express.json());
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use(
    '/kyc',
    createKycRouter({
      kyc: kyc as unknown as KycService,
      authenticate: fakeAuthenticate,
      rateLimitStore: new MemoryRateLimitStore(),
    }),
  );
  app.use(errorHandler);
  return { app, kyc };
}

describe('kyc router', () => {
  it('requires authentication on every route', async () => {
    const { app } = setup();
    for (const [method, path] of [
      ['get', '/kyc'],
      ['post', '/kyc/tier-1'],
      ['post', '/kyc/tier-2'],
      ['put', '/kyc/documents/PASSPORT'],
      ['post', '/kyc/tier-3'],
    ] as const) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('shows the status before contacts are verified, but allows no submission', async () => {
    const { app, kyc } = setup();
    const pending = (req: request.Test) =>
      req.set('X-Test-User', 'u-1').set('X-Test-Status', 'PENDING_VERIFICATION');

    expect((await pending(request(app).get('/kyc'))).status).toBe(200);
    const res = await pending(request(app).post('/kyc/tier-1')).send({ dateOfBirth: '1995-04-12' });
    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(kyc.submitTier1).not.toHaveBeenCalled();
  });

  it('passes validated input for the signed-in user only', async () => {
    const { app, kyc } = setup();
    const res = await request(app)
      .post('/kyc/tier-2')
      .set('X-Test-User', 'u-7')
      .send({ type: 'BVN', idNumber: '222 1234 5678', userId: 'someone-else' });

    expect(res.status).toBe(422); // strict body: unknown fields are refused
    await request(app)
      .post('/kyc/tier-2')
      .set('X-Test-User', 'u-7')
      .send({ type: 'BVN', idNumber: '222 1234 5678' });
    expect(kyc.submitTier2).toHaveBeenCalledWith(
      'u-7',
      { type: 'BVN', idNumber: '22212345678' },
      expect.anything(),
    );
  });

  it('never echoes the identity number back in a validation error', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/kyc/tier-2')
      .set('X-Test-User', 'u-1')
      .send({ type: 'BVN', idNumber: '2221234567X' });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('2221234567');
  });

  it(`limits identity checks to ${String(IDENTITY_CHECK_RATE_LIMIT.limit)} per user per day`, async () => {
    const { app, kyc } = setup();
    const send = (user: string) =>
      request(app)
        .post('/kyc/tier-2')
        .set('X-Test-User', user)
        .send({ type: 'NIN', idNumber: '22212345678' });
    for (let i = 0; i < IDENTITY_CHECK_RATE_LIMIT.limit; i++) await send('u-1');

    expect((await send('u-1')).status).toBe(429);
    expect((await send('u-2')).status).toBe(200);
    expect(kyc.submitTier2).toHaveBeenCalledTimes(IDENTITY_CHECK_RATE_LIMIT.limit + 1);
  });

  it('uploads a file as the raw body and answers 201', async () => {
    const { app, kyc } = setup();
    const res = await request(app)
      .put('/kyc/documents/UTILITY_BILL')
      .set('X-Test-User', 'u-1')
      .set('Content-Type', 'image/png')
      .send(PNG);

    expect(res.status).toBe(201);
    expect(kyc.uploadDocument).toHaveBeenCalledWith(
      'u-1',
      'UTILITY_BILL',
      'image/png',
      PNG,
      expect.anything(),
    );
  });

  it('refuses other content types, unknown document types and oversized files', async () => {
    const { app, kyc } = setup();
    const put = (path: string, type: string, body: Buffer | string) =>
      request(app).put(path).set('X-Test-User', 'u-1').set('Content-Type', type).send(body);

    const svg = await put('/kyc/documents/PASSPORT', 'image/svg+xml', '<svg/>');
    expect(svg.status).toBe(415);
    expect((svg.body as ApiErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect((await put('/kyc/documents/PASSPORT', 'application/json', '{}')).status).toBe(415);
    expect((await put('/kyc/documents/BANK_CARD', 'image/png', PNG)).status).toBe(422);
    const big = Buffer.concat([PNG, Buffer.alloc(KYC_DOCUMENT_MAX_BYTES)]);
    expect((await put('/kyc/documents/PASSPORT', 'image/png', big)).status).toBe(413);
    expect(kyc.uploadDocument).not.toHaveBeenCalled();
  });

  it('answers 202 for a Tier 3 submission (it goes to review)', async () => {
    const { app } = setup();
    const res = await request(app)
      .post('/kyc/tier-3')
      .set('X-Test-User', 'u-1')
      .send({ address: { line1: '1 Marina', city: 'Lagos', state: 'Lagos' } });

    expect(res.status).toBe(202);
  });
});
