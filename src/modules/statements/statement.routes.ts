// Express router for statements: the signed-in user's own.
import { Router, type Request, type RequestHandler } from 'express';
import { authOf } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createStatementController } from './statement.controller.ts';
import type { StatementService } from './statement.service.ts';

/** Each request reads a period of the ledger in the worker. */
export const STATEMENT_RATE_LIMIT: RateLimitPolicy = {
  name: 'statements',
  limit: 10,
  windowMs: 60 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface StatementRouterDependencies {
  statements: StatementService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createStatementRouter({
  statements,
  authenticate,
  rateLimitStore,
}: StatementRouterDependencies): Router {
  const controller = createStatementController(statements);
  const router = Router();

  router.use(authenticate);
  router.post('/', rateLimit(rateLimitStore, STATEMENT_RATE_LIMIT), controller.request);
  router.get('/', controller.list);
  router.get('/:id', controller.get);
  router.get('/:id/download', controller.download);

  return router;
}
