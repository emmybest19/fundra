import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import type { PrismaClient } from '../../../src/generated/prisma/client.ts';
import { authOf, createAuthenticate } from '../../../src/middleware/auth.middleware.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { TokenService } from '../../../src/modules/auth/tokens.ts';

const SECRET = 'unit-test-secret-at-least-32-characters-long';

interface FakeSession {
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  user: { status: string; passwordChangedAt: Date; roles?: { role: { name: string } }[] };
}

function liveSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: { status: 'ACTIVE', passwordChangedAt: new Date(Date.now() - 86_400_000) },
    ...overrides,
  };
}

function appWith(session: FakeSession | null, tokens = new TokenService(SECRET)) {
  // Default: the user holds the USER role, as after registration.
  if (session) session.user.roles ??= [{ role: { name: 'USER' } }];
  const findUnique = vi.fn().mockResolvedValue(session);
  const db = { session: { findUnique } } as unknown as PrismaClient;
  const app = express();
  app.get('/me', createAuthenticate({ db, tokens }), (req, res) => {
    res.json({ auth: authOf(req) });
  });
  app.get('/unprotected', (req, res) => {
    res.json({ auth: authOf(req) });
  });
  app.use(errorHandler);
  return { app, findUnique };
}

const sign = (tokens = new TokenService(SECRET)) =>
  tokens.signAccessToken({ userId: 'user-1', sessionId: 'session-1', roles: ['USER'] });

const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

describe('authenticate', () => {
  it('attaches the caller for a valid token on a live session', async () => {
    const { token } = await sign();
    const { app, findUnique } = appWith(liveSession());

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      auth: { userId: 'user-1', sessionId: 'session-1', roles: ['USER'], status: 'ACTIVE' },
    });
    expect(res.headers).not.toHaveProperty('www-authenticate');
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing header', undefined],
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['not a JWT', 'Bearer not-a-token'],
    ['empty bearer', 'Bearer '],
  ])(
    'rejects a request with %s as 401 UNAUTHENTICATED with WWW-Authenticate',
    async (_c, header) => {
      const { app, findUnique } = appWith(liveSession());
      const req = request(app).get('/me');
      if (header !== undefined) void req.set('Authorization', header);

      const res = await req;

      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer realm="fundra"');
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('reports an expired token as ACCESS_TOKEN_EXPIRED so clients know to refresh', async () => {
    const past = new TokenService(SECRET, () => Date.now() - 16 * 60_000);
    const { token } = await sign(past);
    const { app } = appWith(liveSession());

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('ACCESS_TOKEN_EXPIRED');
  });

  it('rejects a token signed with another key without touching the database', async () => {
    const { token } = await sign(new TokenService('a-different-secret-of-32-characters!!'));
    const { app, findUnique } = appWith(liveSession());

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown session', null],
    ['revoked session (logout, remote sign-out, theft)', liveSession({ revokedAt: new Date() })],
    ['expired session', liveSession({ expiresAt: new Date(Date.now() - 1_000) })],
    ['session of another user', liveSession({ userId: 'user-2' })],
    [
      'token issued before the last password change',
      liveSession({
        user: { status: 'ACTIVE', passwordChangedAt: new Date(Date.now() + 5_000) },
      }),
    ],
  ])('rejects a valid token whose %s', async (_case, session) => {
    const { token } = await sign();
    const { app } = appWith(session);

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it.each(['SUSPENDED', 'DEACTIVATED'])('rejects a %s user with 403', async (status) => {
    const { token } = await sign();
    const { app } = appWith(
      liveSession({ user: { status, passwordChangedAt: new Date(Date.now() - 86_400_000) } }),
    );

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('ACCOUNT_DISABLED');
  });

  it('lets PENDING_VERIFICATION users through (they must be able to verify)', async () => {
    const { token } = await sign();
    const { app } = appWith(
      liveSession({
        user: { status: 'PENDING_VERIFICATION', passwordChangedAt: new Date(0) },
      }),
    );

    expect((await request(app).get('/me').set('Authorization', `Bearer ${token}`)).status).toBe(
      200,
    );
  });
});

describe('authOf', () => {
  it('is a server error on a route mounted without authenticate', async () => {
    const res = await request(appWith(liveSession()).app).get('/unprotected');

    expect(res.status).toBe(500);
  });
});
