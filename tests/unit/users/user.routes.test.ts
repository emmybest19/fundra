import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { MemoryRateLimitStore } from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import {
  ACCOUNT_SECURITY_RATE_LIMIT,
  createUserRouter,
} from '../../../src/modules/users/user.routes.ts';
import type { UserService } from '../../../src/modules/users/user.service.ts';

/** Signs in whoever is named in the X-Test-User header; no header → 401. */
const fakeAuthenticate: RequestHandler = (req, res, next) => {
  const userId = req.get('x-test-user');
  if (userId === undefined) {
    res.status(401).json({ success: false });
    return;
  }
  req.auth = { userId, sessionId: 's-1', roles: ['USER'], status: 'ACTIVE' };
  next();
};

function setup() {
  const users = {
    getProfile: vi.fn().mockResolvedValue({ id: 'u-1' }),
    updateProfile: vi.fn().mockResolvedValue({ id: 'u-1' }),
    getPreferences: vi.fn().mockResolvedValue({ notifications: {} }),
    updatePreferences: vi.fn().mockResolvedValue({ notifications: {} }),
    requestContactChange: vi.fn().mockResolvedValue(undefined),
    confirmContactChange: vi.fn().mockResolvedValue({ id: 'u-1' }),
    deactivate: vi.fn().mockResolvedValue(undefined),
  };
  const passwords = {
    changePassword: vi.fn().mockResolvedValue({
      accessToken: 'new.access.token',
      accessTokenExpiresAt: new Date('2026-10-05T10:15:00Z'),
      refreshToken: 'fnd_rt_new',
      refreshTokenExpiresAt: new Date('2026-11-04T10:00:00Z'),
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use(
    '/users',
    createUserRouter({
      users: users as unknown as UserService,
      passwords,
      authenticate: fakeAuthenticate,
      rateLimitStore: new MemoryRateLimitStore(),
    }),
  );
  app.use(errorHandler);
  const as = (userId: string) => ({
    get: (path: string) => request(app).get(path).set('X-Test-User', userId),
    patch: (path: string) => request(app).patch(path).set('X-Test-User', userId),
    post: (path: string) => request(app).post(path).set('X-Test-User', userId),
  });
  return { app, users, passwords, as };
}

describe('users router', () => {
  it('requires authentication on every route', async () => {
    const { app } = setup();
    for (const [method, path] of [
      ['get', '/users/me'],
      ['patch', '/users/me'],
      ['get', '/users/me/preferences'],
      ['post', '/users/me/email'],
      ['post', '/users/me/deactivate'],
    ] as const) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('only ever acts on the signed-in user', async () => {
    const { users, as } = setup();
    await as('u-42').get('/users/me');
    await as('u-42').patch('/users/me').send({ firstName: 'Ada' });
    expect(users.getProfile).toHaveBeenCalledWith('u-42');
    expect(users.updateProfile).toHaveBeenCalledWith(
      'u-42',
      { firstName: 'Ada' },
      expect.anything(),
    );
  });

  it('validates before calling the service', async () => {
    const { users, as } = setup();
    const res = await as('u-1').patch('/users/me').send({ status: 'ACTIVE' });
    expect(res.status).toBe(422);
    expect((res.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(users.updateProfile).not.toHaveBeenCalled();
  });

  it('answers 202 to a contact change request and passes the normalised address', async () => {
    const { users, as } = setup();
    const res = await as('u-1')
      .post('/users/me/phone')
      .send({ newPhone: '08012345679', password: 'secret' });
    expect(res.status).toBe(202);
    expect(users.requestContactChange).toHaveBeenCalledWith(
      'u-1',
      'phone',
      '+2348012345679',
      'secret',
      expect.anything(),
    );
  });

  it('confirms a contact change with the code bound to the same address', async () => {
    const { users, as } = setup();
    const res = await as('u-1')
      .post('/users/me/email/confirm')
      .send({ newEmail: 'New@Fundra.dev', code: '123456' });
    expect(res.status).toBe(200);
    expect(users.confirmContactChange).toHaveBeenCalledWith(
      'u-1',
      'email',
      'new@fundra.dev',
      '123456',
      expect.anything(),
    );
  });

  it('answers 204 to deactivation', async () => {
    const { users, as } = setup();
    const res = await as('u-1')
      .post('/users/me/deactivate')
      .send({ password: 'secret', reason: 'OTHER' });
    expect(res.status).toBe(204);
    expect(users.deactivate).toHaveBeenCalledWith('u-1', 'secret', 'OTHER', expect.anything());
  });

  it('changes the password for this session and returns the new tokens, uncacheable', async () => {
    const { passwords, as } = setup();
    const res = await as('u-1')
      .post('/users/me/password')
      .send({ currentPassword: 'old secret', newPassword: 'brand new secret 9' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: {
        tokenType: 'Bearer',
        accessToken: 'new.access.token',
        accessTokenExpiresAt: '2026-10-05T10:15:00.000Z',
        refreshToken: 'fnd_rt_new',
        refreshTokenExpiresAt: '2026-11-04T10:00:00.000Z',
      },
    });
    expect(passwords.changePassword).toHaveBeenCalledWith(
      'u-1',
      's-1',
      'old secret',
      'brand new secret 9',
      expect.anything(),
    );
  });

  it('rejects a new password that breaks the policy before calling the service', async () => {
    const { passwords, as } = setup();
    const res = await as('u-1')
      .post('/users/me/password')
      .send({ currentPassword: 'old secret', newPassword: 'short' });
    expect(res.status).toBe(422);
    expect(passwords.changePassword).not.toHaveBeenCalled();
  });

  it('rate-limits sensitive actions per user, not per IP', async () => {
    const { as } = setup();
    const body = { password: 'secret' };
    for (let i = 0; i < ACCOUNT_SECURITY_RATE_LIMIT.limit; i++) {
      expect((await as('u-1').post('/users/me/deactivate').send(body)).status).toBe(204);
    }
    expect((await as('u-1').post('/users/me/deactivate').send(body)).status).toBe(429);
    // Same IP, different account: unaffected.
    expect((await as('u-2').post('/users/me/deactivate').send(body)).status).toBe(204);
    // Reads aren't part of the sensitive budget.
    expect((await as('u-1').get('/users/me')).status).toBe(200);
  });
});
