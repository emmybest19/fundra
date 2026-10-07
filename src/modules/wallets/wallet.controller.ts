// HTTP layer for wallets: parse request, call service, shape response.
import type { Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { walletParams } from './wallet.schema.ts';
import type { WalletService } from './wallet.service.ts';

/** Balances are financial data: never kept by browsers or proxies. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createWalletController(wallets: WalletService) {
  return {
    list: validated({}, async (_input, req, res) => {
      noStore(res).json(success({ wallets: await wallets.list(authOf(req).userId) }));
    }),

    get: validated({ params: walletParams }, async ({ params }, req, res) => {
      noStore(res).json(success({ wallet: await wallets.get(authOf(req).userId, params.id) }));
    }),
  };
}
