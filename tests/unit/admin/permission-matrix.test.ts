// Every admin route × every role, through the real router and the real `authorize`. The
// services behind it are stand-ins: this checks the guard, not the work.
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { hasPermissions, ROLES, type RoleName } from '../../../src/common/constants/rbac.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import {
  ADMIN_ROUTES,
  createAdminRouter,
  type AdminRouterDependencies,
} from '../../../src/modules/admin/admin.routes.ts';

const ID = '01a1407d-89c4-7fff-9ad3-9b767ad1c8c6';

/** Any service method resolves with something list-shaped; enough for every handler. */
const stand_in = new Proxy(
  {},
  { get: () => () => Promise.resolve({ items: [], nextCursor: null, userId: ID, roles: [] }) },
);

const fakeAuthenticate: RequestHandler = (req, res, next) => {
  const header = req.get('x-test-roles');
  if (header === undefined) {
    res.status(401).json({});
    return;
  }
  const status =
    req.get('x-test-status') === 'PENDING_VERIFICATION' ? 'PENDING_VERIFICATION' : 'ACTIVE';
  req.auth = {
    userId: 'staff-user',
    sessionId: 's',
    roles: header === '' ? [] : (header.split(',') as RoleName[]),
    status,
  };
  next();
};

function app() {
  const server = express();
  server.use(express.json());
  server.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  server.use(
    '/admin',
    createAdminRouter({
      admin: stand_in,
      settings: stand_in,
      kyc: stand_in,
      wallets: stand_in,
      reversals: stand_in,
      roles: stand_in,
      authenticate: fakeAuthenticate,
    } as unknown as AdminRouterDependencies),
  );
  server.use(errorHandler);
  return server;
}

const concrete = (path: string) =>
  path
    .replace(':id', ID)
    .replace(':tier', '1')
    .replace(':currency', 'NGN')
    .replace(':transactionType', 'TRANSFER')
    .replace(':role', 'SUPPORT');

const call = (route: (typeof ADMIN_ROUTES)[number]) =>
  request(app())
    [route.method](`/admin${concrete(route.path)}`)
    .send({});

describe('admin permission matrix', () => {
  for (const route of ADMIN_ROUTES) {
    describe(`${route.method.toUpperCase()} ${route.path} (${route.permission})`, () => {
      for (const role of ROLES) {
        const allowed = hasPermissions([role], [route.permission]);
        it(`${role}: ${allowed ? 'allowed' : '403'}`, async () => {
          const res = await call(route).set('X-Test-Roles', role);
          if (allowed) {
            expect(res.status).not.toBe(403);
          } else {
            expect(res.status).toBe(403);
            expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
          }
        });
      }

      it('no roles at all: 403; no token: 401; unverified staff: 403 ACCOUNT_NOT_ACTIVE', async () => {
        expect((await call(route).set('X-Test-Roles', '')).status).toBe(403);
        expect((await call(route)).status).toBe(401);
        const unverified = await call(route)
          .set('X-Test-Roles', 'SUPER_ADMIN')
          .set('X-Test-Status', 'PENDING_VERIFICATION');
        expect((unverified.body as ApiErrorBody).error.code).toBe('ACCOUNT_NOT_ACTIVE');
      });
    });
  }

  it('SUPER_ADMIN alone reaches every route; customers (USER) reach none', () => {
    for (const route of ADMIN_ROUTES) {
      expect(hasPermissions(['SUPER_ADMIN'], [route.permission])).toBe(true);
      expect(hasPermissions(['USER'], [route.permission])).toBe(false);
    }
  });

  it('separation of duties: KYC decisions and reversals sit in different roles', () => {
    const decides = (role: RoleName) => hasPermissions([role], ['kyc:review']);
    const reverses = (role: RoleName) => hasPermissions([role], ['transactions:reverse']);
    for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(decides(role) && reverses(role), role).toBe(false);
    }
  });

  it('each route needs exactly the permission in this spec (a change here must be deliberate)', () => {
    expect(
      Object.fromEntries(ADMIN_ROUTES.map((r) => [`${r.method} ${r.path}`, r.permission])),
    ).toEqual({
      'get /users': 'users:read',
      'get /users/:id': 'users:read',
      'post /users/:id/suspend': 'users:suspend',
      'post /users/:id/reactivate': 'users:suspend',
      'get /kyc': 'kyc:read',
      'get /kyc/:id': 'kyc:read',
      'post /kyc/:id/review': 'kyc:review',
      'post /kyc/:id/approve': 'kyc:review',
      'post /kyc/:id/reject': 'kyc:review',
      'get /transactions': 'transactions:read',
      'get /transactions/:id': 'transactions:read',
      'post /transactions/:id/reverse': 'transactions:reverse',
      'get /wallets/:id': 'wallets:read',
      'post /wallets/:id/freeze': 'wallets:freeze',
      'post /wallets/:id/unfreeze': 'wallets:freeze',
      'post /wallets/:id/reopen': 'wallets:freeze',
      'get /webhooks': 'webhooks:read',
      'get /audit-logs': 'audit_logs:read',
      'get /roles': 'roles:assign',
      'post /users/:id/roles': 'roles:assign',
      'delete /users/:id/roles/:role': 'roles:assign',
      'get /settings': 'settings:read',
      'put /settings/tier-limits/:tier/:currency': 'settings:update',
      'put /settings/fee-rules/:transactionType/:currency': 'settings:update',
    });
  });
});
