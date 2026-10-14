// Express router for transfers: P2P sends from the signed-in user's wallet.
import { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createTransferController } from './transfer.controller.ts';
import type { TransferService } from './transfer.service.ts';

/** Sends per user. Idempotent retries count too, which is fine: they're cheap and rare. */
export const TRANSFER_RATE_LIMIT: RateLimitPolicy = {
  name: 'transfers',
  limit: 20,
  windowMs: 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

/** D2: recipient lookups per user, so account numbers and handles can't be enumerated. */
export const RECIPIENT_LOOKUP_RATE_LIMIT: RateLimitPolicy = {
  name: 'transfer-recipient-lookup',
  limit: 60,
  windowMs: 60 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface TransferRouterDependencies {
  transfers: TransferService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createTransferRouter({
  transfers,
  authenticate,
  rateLimitStore,
}: TransferRouterDependencies): Router {
  const controller = createTransferController(transfers);
  const router = Router();

  router.use(authenticate, requireActiveAccount);
  router.get(
    '/recipient',
    rateLimit(rateLimitStore, RECIPIENT_LOOKUP_RATE_LIMIT),
    controller.lookupRecipient,
  );
  router.post('/', rateLimit(rateLimitStore, TRANSFER_RATE_LIMIT), controller.create);

  return router;
}
