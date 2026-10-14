// Express router for payments: deposits now; withdrawals and payments follow (Stage 14).
import { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import type { DepositService } from './deposit.service.ts';
import { createPaymentController } from './payment.controller.ts';

/** Each deposit opens a provider session: a few a minute is plenty for a person. */
export const DEPOSIT_RATE_LIMIT: RateLimitPolicy = {
  name: 'deposits',
  limit: 10,
  windowMs: 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface PaymentRouterDependencies {
  deposits: DepositService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createPaymentRouter({
  deposits,
  authenticate,
  rateLimitStore,
}: PaymentRouterDependencies): Router {
  const controller = createPaymentController(deposits);
  const router = Router();

  router.use(authenticate, requireActiveAccount);
  router.post('/deposits', rateLimit(rateLimitStore, DEPOSIT_RATE_LIMIT), controller.createDeposit);

  return router;
}
