// HTTP layer for transactions: parse request, call service, shape response.
import type { Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { historyQuery, transactionParams } from './transaction.schema.ts';
import type { TransactionService } from './transaction.service.ts';

/** Financial history: never kept by browsers or proxies. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createTransactionController(transactions: TransactionService) {
  return {
    list: validated({ query: historyQuery }, async ({ query }, req, res) => {
      const page = await transactions.list(authOf(req).userId, query);
      noStore(res).json(
        success(
          { transactions: page.transactions },
          { limit: query.limit, nextCursor: page.nextCursor },
        ),
      );
    }),

    get: validated({ params: transactionParams }, async ({ params }, req, res) => {
      const transaction = await transactions.get(authOf(req).userId, params.id);
      noStore(res).json(success({ transaction }));
    }),
  };
}
