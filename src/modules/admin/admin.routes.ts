// Express router for admin (RBAC protected). Every route is declared once in ADMIN_ROUTES
// with the permission it needs, and the router is built from that table, so a route can't
// be mounted without its guard, and tests can check every route against every role.
import { Router, type RequestHandler } from 'express';
import type { Permission } from '../../common/constants/rbac.ts';
import { authorize, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  createAdminController,
  type AdminController,
  type AdminControllerDependencies,
} from './admin.controller.ts';

export interface AdminRoute {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  permission: Permission;
  handler: keyof AdminController;
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { method: 'get', path: '/users', permission: 'users:read', handler: 'listUsers' },
  { method: 'get', path: '/users/:id', permission: 'users:read', handler: 'getUser' },
  {
    method: 'post',
    path: '/users/:id/suspend',
    permission: 'users:suspend',
    handler: 'suspendUser',
  },
  {
    method: 'post',
    path: '/users/:id/reactivate',
    permission: 'users:suspend',
    handler: 'reactivateUser',
  },

  { method: 'get', path: '/kyc', permission: 'kyc:read', handler: 'kycQueue' },
  { method: 'get', path: '/kyc/:id', permission: 'kyc:read', handler: 'getKyc' },
  { method: 'post', path: '/kyc/:id/review', permission: 'kyc:review', handler: 'startKycReview' },
  { method: 'post', path: '/kyc/:id/approve', permission: 'kyc:review', handler: 'approveKyc' },
  { method: 'post', path: '/kyc/:id/reject', permission: 'kyc:review', handler: 'rejectKyc' },

  {
    method: 'get',
    path: '/transactions',
    permission: 'transactions:read',
    handler: 'listTransactions',
  },
  {
    method: 'get',
    path: '/transactions/:id',
    permission: 'transactions:read',
    handler: 'getTransaction',
  },
  {
    method: 'post',
    path: '/transactions/:id/reverse',
    permission: 'transactions:reverse',
    handler: 'reverseTransaction',
  },

  { method: 'get', path: '/wallets/:id', permission: 'wallets:read', handler: 'getWallet' },
  {
    method: 'post',
    path: '/wallets/:id/freeze',
    permission: 'wallets:freeze',
    handler: 'freezeWallet',
  },
  {
    method: 'post',
    path: '/wallets/:id/unfreeze',
    permission: 'wallets:freeze',
    handler: 'unfreezeWallet',
  },
  {
    method: 'post',
    path: '/wallets/:id/reopen',
    permission: 'wallets:freeze',
    handler: 'reopenWallet',
  },

  { method: 'get', path: '/webhooks', permission: 'webhooks:read', handler: 'listWebhooks' },
  { method: 'get', path: '/audit-logs', permission: 'audit_logs:read', handler: 'listAuditLogs' },

  { method: 'get', path: '/roles', permission: 'roles:assign', handler: 'listRoles' },
  { method: 'post', path: '/users/:id/roles', permission: 'roles:assign', handler: 'grantRole' },
  {
    method: 'delete',
    path: '/users/:id/roles/:role',
    permission: 'roles:assign',
    handler: 'revokeRole',
  },

  { method: 'get', path: '/settings', permission: 'settings:read', handler: 'getSettings' },
  {
    method: 'put',
    path: '/settings/tier-limits/:tier/:currency',
    permission: 'settings:update',
    handler: 'updateTierLimit',
  },
  {
    method: 'put',
    path: '/settings/fee-rules/:transactionType/:currency',
    permission: 'settings:update',
    handler: 'updateFeeRule',
  },
];

export interface AdminRouterDependencies extends AdminControllerDependencies {
  authenticate: RequestHandler;
}

export function createAdminRouter({ authenticate, ...services }: AdminRouterDependencies): Router {
  const controller = createAdminController(services);
  const router = Router();

  // Staff accounts must be verified like customers moving money.
  router.use(authenticate, requireActiveAccount);
  for (const route of ADMIN_ROUTES) {
    router[route.method](route.path, authorize(route.permission), controller[route.handler]);
  }
  return router;
}
