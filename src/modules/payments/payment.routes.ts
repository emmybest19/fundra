// Express router for payments: deposits, withdrawals and bill payments.
import { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import type { DepositService } from './deposit.service.ts';
import { createPaymentController } from './payment.controller.ts';
import type { OutboundPaymentService } from './outbound-payment.service.ts';

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

export const BILL_PAYMENT_RATE_LIMIT: RateLimitPolicy = {
  name: 'bill-payments',
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
  outbound: OutboundPaymentService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createPaymentRouter({
  deposits,
  outbound,
  authenticate,
  rateLimitStore,
}: PaymentRouterDependencies): Router {
  const controller = createPaymentController(deposits, outbound);
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
  router.get('/billers', controller.listBillers);
  router.post('/bills', rateLimit(rateLimitStore, BILL_PAYMENT_RATE_LIMIT), controller.payBill);

  return router;
}
