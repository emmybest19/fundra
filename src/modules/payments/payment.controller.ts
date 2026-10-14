// HTTP layer for deposits (and withdrawals, Stage 14 item 3).
import type { Response } from 'express';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeyFrom,
  requestFingerprint,
} from '../../common/idempotency/idempotency.http.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import type { DepositService } from './deposit.service.ts';
import { createDepositBody } from './payment.schema.ts';

const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createPaymentController(deposits: DepositService) {
  return {
    createDeposit: validated({ body: createDepositBody }, async ({ body }, req, res) => {
      // The key and fingerprint come first: a missing key is a 400 before anything runs.
      const idempotency = { key: idempotencyKeyFrom(req), fingerprint: requestFingerprint(req) };
      const result = await deposits.create(
        authOf(req).userId,
        body,
        idempotency,
        auditContextFrom(req),
      );
      if (result.replayed) res.set(IDEMPOTENT_REPLAYED_HEADER, 'true');
      noStore(res).status(result.status).json(result.body);
    }),
  };
}
