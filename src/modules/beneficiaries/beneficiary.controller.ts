// HTTP layer for beneficiaries.
import type { Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import {
  beneficiaryParams,
  createBeneficiaryBody,
  listBeneficiariesQuery,
  updateBeneficiaryBody,
} from './beneficiary.schema.ts';
import type { BeneficiaryService } from './beneficiary.service.ts';

/** Saved account details: never cached. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createBeneficiaryController(beneficiaries: BeneficiaryService) {
  return {
    list: validated({ query: listBeneficiariesQuery }, async ({ query }, req, res) => {
      noStore(res).json(
        success({ beneficiaries: await beneficiaries.list(authOf(req).userId, query.type) }),
      );
    }),

    get: validated({ params: beneficiaryParams }, async ({ params }, req, res) => {
      noStore(res).json(
        success({ beneficiary: await beneficiaries.get(authOf(req).userId, params.id) }),
      );
    }),

    create: validated({ body: createBeneficiaryBody }, async ({ body }, req, res) => {
      const beneficiary = await beneficiaries.create(
        authOf(req).userId,
        body,
        auditContextFrom(req),
      );
      noStore(res).status(201).json(success({ beneficiary }));
    }),

    update: validated(
      { params: beneficiaryParams, body: updateBeneficiaryBody },
      async ({ params, body }, req, res) => {
        const beneficiary = await beneficiaries.update(
          authOf(req).userId,
          params.id,
          body.nickname,
          auditContextFrom(req),
        );
        noStore(res).json(success({ beneficiary }));
      },
    ),

    remove: validated({ params: beneficiaryParams }, async ({ params }, req, res) => {
      await beneficiaries.delete(authOf(req).userId, params.id, auditContextFrom(req));
      res.status(204).end();
    }),
  };
}
