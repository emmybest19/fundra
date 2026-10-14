// HTTP layer for transfers: parse request, call service, shape response.
import type { Response } from 'express';
import {
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyKeyFrom,
  requestFingerprint,
} from '../../common/idempotency/idempotency.http.ts';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { createTransferBody, recipientQuery } from './transfer.schema.ts';
import type { TransferService } from './transfer.service.ts';

const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createTransferController(transfers: TransferService) {
  return {
    lookupRecipient: validated({ query: recipientQuery }, async ({ query }, _req, res) => {
      noStore(res).json(success({ recipient: await transfers.lookupRecipient(query) }));
    }),

    create: validated({ body: createTransferBody }, async ({ body }, req, res) => {
      // The key and fingerprint come first: a missing key is a 400 before anything runs.
      const idempotency = { key: idempotencyKeyFrom(req), fingerprint: requestFingerprint(req) };
      const result = await transfers.create(
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
