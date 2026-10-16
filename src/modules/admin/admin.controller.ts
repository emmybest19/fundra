// HTTP layer for admin operations. Every handler acts as the signed-in admin; permissions
// are checked by the router before any of these run.
import type { Request, Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import type { KycService } from '../kyc/kyc.service.ts';
import type { TransferReversalService } from '../transfers/transfer-reversal.service.ts';
import type { WalletService } from '../wallets/wallet.service.ts';
import {
  auditQuery,
  feeRuleBody,
  feeRuleParams,
  idParams,
  kycQueueQuery,
  reasonBody,
  roleBody,
  roleParams,
  tierLimitBody,
  tierLimitParams,
  transactionsQuery,
  usersQuery,
  webhooksQuery,
} from './admin.schema.ts';
import type { AdminRoleService } from './admin-roles.service.ts';
import type { AdminSettingsService } from './admin-settings.service.ts';
import type { AdminService } from './admin.service.ts';

/** Admin views carry personal and financial data: never cached. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

const send = (res: Response, data: unknown, meta?: unknown) =>
  noStore(res).json(meta === undefined ? success(data) : success(data, meta));

export interface AdminControllerDependencies {
  admin: AdminService;
  settings: AdminSettingsService;
  kyc: KycService;
  wallets: WalletService;
  reversals: TransferReversalService;
  roles: AdminRoleService;
}

export function createAdminController({
  admin,
  settings,
  kyc,
  wallets,
  reversals,
  roles,
}: AdminControllerDependencies) {
  const adminId = (req: Request) => authOf(req).userId;

  return {
    // Users
    listUsers: validated({ query: usersQuery }, async ({ query }, _req, res) => {
      const result = await admin.listUsers(query);
      send(res, { users: result.items }, { limit: query.limit, nextCursor: result.nextCursor });
    }),
    getUser: validated({ params: idParams }, async ({ params }, _req, res) => {
      send(res, { user: await admin.getUser(params.id) });
    }),
    suspendUser: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        const { userId, roles } = authOf(req);
        send(res, {
          user: await admin.suspendUser(
            params.id,
            { userId, roles },
            body.reason,
            auditContextFrom(req),
          ),
        });
      },
    ),
    reactivateUser: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        send(res, {
          user: await admin.reactivateUser(
            params.id,
            adminId(req),
            body.reason,
            auditContextFrom(req),
          ),
        });
      },
    ),

    // KYC
    kycQueue: validated({ query: kycQueueQuery }, async ({ query }, _req, res) => {
      send(res, { profiles: await admin.kycQueue(query.status) });
    }),
    getKyc: validated({ params: idParams }, async ({ params }, _req, res) => {
      const userId = await admin.kycProfileOwner(params.id);
      send(res, { profileId: params.id, userId, kyc: await kyc.getOverview(userId) });
    }),
    startKycReview: validated({ params: idParams }, async ({ params }, req, res) => {
      await admin.kycProfileOwner(params.id);
      send(res, { case: await kyc.startReview(params.id, adminId(req), auditContextFrom(req)) });
    }),
    approveKyc: validated({ params: idParams }, async ({ params }, req, res) => {
      await admin.kycProfileOwner(params.id);
      send(res, { kyc: await kyc.approve(params.id, adminId(req), auditContextFrom(req)) });
    }),
    rejectKyc: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        await admin.kycProfileOwner(params.id);
        send(res, {
          kyc: await kyc.reject(params.id, adminId(req), body.reason, auditContextFrom(req)),
        });
      },
    ),

    // Transactions
    listTransactions: validated({ query: transactionsQuery }, async ({ query }, _req, res) => {
      const result = await admin.listTransactions(query);
      send(
        res,
        { transactions: result.items },
        { limit: query.limit, nextCursor: result.nextCursor },
      );
    }),
    getTransaction: validated({ params: idParams }, async ({ params }, _req, res) => {
      send(res, { transaction: await admin.getTransaction(params.id) });
    }),
    reverseTransaction: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        send(res, {
          reversal: await reversals.reverse(
            params.id,
            adminId(req),
            body.reason,
            auditContextFrom(req),
          ),
        });
      },
    ),

    // Wallets
    getWallet: validated({ params: idParams }, async ({ params }, _req, res) => {
      send(res, { wallet: await admin.getWallet(params.id) });
    }),
    freezeWallet: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        await wallets.freeze(params.id, adminId(req), body.reason, auditContextFrom(req));
        send(res, { wallet: await admin.getWallet(params.id) });
      },
    ),
    unfreezeWallet: validated(
      { params: idParams, body: reasonBody },
      async ({ params, body }, req, res) => {
        await wallets.unfreeze(params.id, adminId(req), body.reason, auditContextFrom(req));
        send(res, { wallet: await admin.getWallet(params.id) });
      },
    ),
    reopenWallet: validated({ params: idParams }, async ({ params }, req, res) => {
      await wallets.reopen(params.id, adminId(req), auditContextFrom(req));
      send(res, { wallet: await admin.getWallet(params.id) });
    }),

    // Webhooks and audit
    listWebhooks: validated({ query: webhooksQuery }, async ({ query }, _req, res) => {
      const result = await admin.listWebhooks(query);
      send(res, { webhooks: result.items }, { limit: query.limit, nextCursor: result.nextCursor });
    }),
    listAuditLogs: validated({ query: auditQuery }, async ({ query }, _req, res) => {
      const result = await admin.listAuditLogs(query);
      send(res, { auditLogs: result.items }, { limit: query.limit, nextCursor: result.nextCursor });
    }),

    // Roles
    listRoles: async (_req: Request, res: Response) => {
      send(res, { roles: await roles.list() });
    },
    grantRole: validated(
      { params: idParams, body: roleBody },
      async ({ params, body }, req, res) => {
        send(res, await roles.grant(params.id, body.role, adminId(req), auditContextFrom(req)));
      },
    ),
    revokeRole: validated({ params: roleParams }, async ({ params }, req, res) => {
      send(res, await roles.revoke(params.id, params.role, adminId(req), auditContextFrom(req)));
    }),

    // Settings
    getSettings: async (_req: Request, res: Response) => {
      send(res, { settings: await settings.get() });
    },
    updateTierLimit: validated(
      { params: tierLimitParams, body: tierLimitBody },
      async ({ params, body }, req, res) => {
        send(res, {
          tierLimit: await settings.updateTierLimit(
            params.tier,
            params.currency,
            body,
            adminId(req),
            auditContextFrom(req),
          ),
        });
      },
    ),
    updateFeeRule: validated(
      { params: feeRuleParams, body: feeRuleBody },
      async ({ params, body }, req, res) => {
        send(res, {
          feeRule: await settings.updateFeeRule(
            params.transactionType,
            params.currency,
            body,
            adminId(req),
            auditContextFrom(req),
          ),
        });
      },
    ),
  };
}

export type AdminController = ReturnType<typeof createAdminController>;
