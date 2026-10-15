// Express router for payments: deposits and withdrawals (payments follow, Stage 14).
import { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import type { DepositService } from './deposit.service.ts';
import { createPaymentController } from './payment.controller.ts';
import type { WithdrawalService } from './withdrawal.service.ts';

const perUser = (req: Request) => `user:${authOf(req).userId}`;

/** Each deposit opens a provider session: a few a minute is plenty for a person. */
export const DEPOSIT_RATE_LIMIT: RateLimitPolicy = {
  name: 'deposits',
  limit: 10,
  windowMs: 60 * 1_000,
  key: perUser,
};

export const WITHDRAWAL_RATE_LIMIT: RateLimitPolicy = {
  name: 'withdrawals',
  limit: 10,
  windowMs: 60 * 1_000,
  key: perUser,
};

/** Name enquiries reveal who owns an account: limited like recipient lookups (D2). */
export const BANK_ACCOUNT_LOOKUP_RATE_LIMIT: RateLimitPolicy = {
  name: 'bank-account-lookup',
  limit: 30,
  windowMs: 60 * 60 * 1_000,
  key: perUser,
};

export interface PaymentRouterDependencies {
  deposits: DepositService;
  withdrawals: WithdrawalService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createPaymentRouter({
  deposits,
  withdrawals,
  authenticate,
  rateLimitStore,
}: PaymentRouterDependencies): Router {
  const controller = createPaymentController(deposits, withdrawals);
  const router = Router();

  router.use(authenticate, requireActiveAccount);
  router.post('/deposits', rateLimit(rateLimitStore, DEPOSIT_RATE_LIMIT), controller.createDeposit);
  router.get(
    '/bank-accounts/resolve',
    rateLimit(rateLimitStore, BANK_ACCOUNT_LOOKUP_RATE_LIMIT),
    controller.resolveBankAccount,
  );
  router.post(
    '/withdrawals',
    rateLimit(rateLimitStore, WITHDRAWAL_RATE_LIMIT),
    controller.createWithdrawal,
  );

  return router;
}
