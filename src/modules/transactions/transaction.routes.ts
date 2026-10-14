// Express router for transactions: the signed-in user's own history. Admins investigate
// transactions through the admin module (Stage 19).
import { Router, type RequestHandler } from 'express';
import { createTransactionController } from './transaction.controller.ts';
import type { TransactionService } from './transaction.service.ts';

export interface TransactionRouterDependencies {
  transactions: TransactionService;
  authenticate: RequestHandler;
}

export function createTransactionRouter({
  transactions,
  authenticate,
}: TransactionRouterDependencies): Router {
  const controller = createTransactionController(transactions);
  const router = Router();

  router.use(authenticate);
  router.get('/', controller.list);
  router.get('/:id', controller.get);

  return router;
}
