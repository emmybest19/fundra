// HTTP layer for deposits and withdrawals.
import type { Request, Response } from 'express';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeyFrom,
  requestFingerprint,
} from '../../common/idempotency/idempotency.http.ts';
import type { IdempotentResult } from '../../common/idempotency/idempotency.service.ts';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import type { DepositService } from './deposit.service.ts';
import { bankAccountQuery, createDepositBody, createWithdrawalBody } from './payment.schema.ts';
import type { WithdrawalService } from './withdrawal.service.ts';

const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

/** The key and fingerprint come first: a missing key is a 400 before anything runs. */
const idempotencyOf = (req: Request) => ({
  key: idempotencyKeyFrom(req),
  fingerprint: requestFingerprint(req),
});

function sendIdempotent(res: Response, result: IdempotentResult): void {
  if (result.replayed) res.set(IDEMPOTENT_REPLAYED_HEADER, 'true');
  noStore(res).status(result.status).json(result.body);
}

export function createPaymentController(deposits: DepositService, withdrawals: WithdrawalService) {
  return {
    createDeposit: validated({ body: createDepositBody }, async ({ body }, req, res) => {
      const idempotency = idempotencyOf(req);
      sendIdempotent(
        res,
        await deposits.create(authOf(req).userId, body, idempotency, auditContextFrom(req)),
      );
    }),

    resolveBankAccount: validated({ query: bankAccountQuery }, async ({ query }, _req, res) => {
      noStore(res).json(success({ account: await withdrawals.resolveBankAccount(query) }));
    }),

    createWithdrawal: validated({ body: createWithdrawalBody }, async ({ body }, req, res) => {
      const idempotency = idempotencyOf(req);
      sendIdempotent(
        res,
        await withdrawals.create(authOf(req).userId, body, idempotency, auditContextFrom(req)),
      );
    }),
  };
}
