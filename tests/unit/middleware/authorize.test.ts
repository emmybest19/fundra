import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { hasPermissions, permissionsFor } from '../../../src/common/constants/rbac.ts';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { createLogger } from '../../../src/config/logger.ts';
import type { PrismaClient } from '../../../src/generated/prisma/client.ts';
import {
  authOf,
  authorize,
  createAuthenticate,
  requireActiveAccount,
} from '../../../src/middleware/auth.middleware.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { TokenService } from '../../../src/modules/auth/tokens.ts';

const tokens = new TokenService('unit-test-secret-at-least-32-characters-long');

/** An app whose caller has the given database roles and status. */
async function callerWith(roles: string[], status = 'ACTIVE') {
  const session = {
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      status,
      passwordChangedAt: new Date(0),
      roles: roles.map((name) => ({ role: { name } })),
    },
  };
  const db = {
    session: { findUnique: vi.fn().mockResolvedValue(session) },
  } as unknown as PrismaClient;
  const app = express();
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  const authenticate = createAuthenticate({ db, tokens });
  app.get('/whoami', authenticate, (req, res) => res.json(authOf(req)));
  app.post('/kyc/review', authenticate, authorize('kyc:review'), (_req, res) =>
    res.json({ ok: true }),
  );
  app.post('/both', authenticate, authorize('kyc:review', 'transactions:reverse'), (_req, res) =>
    res.json({ ok: true }),
  );
  app.post('/transfers', authenticate, requireActiveAccount, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);

  // The token deliberately claims only USER: authorization must use the database roles.
  const { token } = await tokens.signAccessToken({
    userId: 'user-1',
    sessionId: 's-1',
    roles: ['USER'],
  });
  return (method: 'get' | 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

describe('permission resolution', () => {
  it('unions the permissions of all roles', () => {
    const granted = permissionsFor(['SUPPORT', 'FINANCE']);

    expect(granted.has('users:read')).toBe(true); // SUPPORT
    expect(granted.has('transactions:reverse')).toBe(true); // FINANCE
    expect(granted.has('kyc:review')).toBe(false); // neither
  });

  it('requires every permission listed', () => {
    expect(hasPermissions(['COMPLIANCE'], ['kyc:review'])).toBe(true);
    expect(hasPermissions(['COMPLIANCE'], ['kyc:review', 'transactions:reverse'])).toBe(false);
    expect(hasPermissions(['COMPLIANCE', 'FINANCE'], ['kyc:review', 'transactions:reverse'])).toBe(
      true,
    );
    expect(hasPermissions([], ['users:read'])).toBe(false);
  });
});

describe('authenticate loads roles from the database', () => {
  it('uses database roles, not the token claim', async () => {
    const as = await callerWith(['COMPLIANCE']);

    expect((await as('get', '/whoami')).body).toMatchObject({ roles: ['COMPLIANCE'] });
  });

  it('ignores role names it does not know (they grant nothing)', async () => {
    const as = await callerWith(['USER', 'LEGACY_ROLE']);

    expect((await as('get', '/whoami')).body).toMatchObject({ roles: ['USER'] });
  });
});

describe('authorize', () => {
  it.each([
    ['COMPLIANCE', 200],
    ['SUPER_ADMIN', 200],
    ['ADMIN', 403],
    ['SUPPORT', 403],
    ['FINANCE', 403],
    ['USER', 403],
  ])('kyc:review as %s → %i', async (role, status) => {
    const as = await callerWith([role]);

    expect((await as('post', '/kyc/review')).status).toBe(status);
  });

  it('answers 403 FORBIDDEN without naming the missing permission', async () => {
    const res = await (await callerWith(['USER']))('post', '/kyc/review');

    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(res.text).not.toContain('kyc:review');
  });

  it('requires all listed permissions (separation of duties holds)', async () => {
    expect((await (await callerWith(['COMPLIANCE']))('post', '/both')).status).toBe(403);
    expect((await (await callerWith(['FINANCE']))('post', '/both')).status).toBe(403);
    expect((await (await callerWith(['COMPLIANCE', 'FINANCE']))('post', '/both')).status).toBe(200);
  });

  it('rejects misspelled permissions at compile time', () => {
    // @ts-expect-error -- 'kyc:approve' is not a permission
    const handler = authorize('kyc:approve');
    expect(handler).toBeTypeOf('function');
  });
});

describe('requireActiveAccount', () => {
  it.each([
    ['ACTIVE', 200],
    ['PENDING_VERIFICATION', 403],
  ])('%s → %i', async (status, expected) => {
    const res = await (await callerWith(['USER'], status))('post', '/transfers');

    expect(res.status).toBe(expected);
    if (expected === 403) expect(errorOf(res).code).toBe('ACCOUNT_NOT_ACTIVE');
  });
});
