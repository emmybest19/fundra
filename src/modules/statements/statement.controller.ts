// HTTP layer for statements.
import type { Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { listStatementsQuery, requestStatementBody, statementParams } from './statement.schema.ts';
import type { StatementService } from './statement.service.ts';

/** Financial records: never cached. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createStatementController(statements: StatementService) {
  return {
    request: validated({ body: requestStatementBody }, async ({ body }, req, res) => {
      const statement = await statements.request(authOf(req).userId, body);
      // 202: accepted; the worker generates it and a notification says when it is ready.
      noStore(res).status(202).json(success({ statement }));
    }),

    list: validated({ query: listStatementsQuery }, async ({ query }, req, res) => {
      noStore(res).json(
        success({ statements: await statements.list(authOf(req).userId, query.walletId) }),
      );
    }),

    get: validated({ params: statementParams }, async ({ params }, req, res) => {
      noStore(res).json(
        success({ statement: await statements.get(authOf(req).userId, params.id) }),
      );
    }),

    download: validated({ params: statementParams }, async ({ params }, req, res) => {
      const file = await statements.download(authOf(req).userId, params.id);
      noStore(res)
        .set({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${file.filename}"`,
        })
        .send(Buffer.from(file.content));
    }),
  };
}
