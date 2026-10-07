// Express router for wallets. Every route reads the signed-in user's own wallets; admins act
// on other wallets through the admin module (Stage 19).
import { Router, type RequestHandler } from 'express';
import { createWalletController } from './wallet.controller.ts';
import type { WalletService } from './wallet.service.ts';

export interface WalletRouterDependencies {
  wallets: WalletService;
  authenticate: RequestHandler;
}

export function createWalletRouter({ wallets, authenticate }: WalletRouterDependencies): Router {
  const controller = createWalletController(wallets);
  const router = Router();

  router.use(authenticate);
  router.get('/', controller.list);
  router.get('/:id', controller.get);

  return router;
}
