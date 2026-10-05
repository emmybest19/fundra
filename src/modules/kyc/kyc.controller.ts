// HTTP layer for kyc: parse request, call service, shape response.
import { UnsupportedMediaTypeError } from '../../common/errors/index.ts';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { documentParams, tier1Body, tier2Body, tier3Body } from './kyc.schema.ts';
import type { KycService } from './kyc.service.ts';

export function createKycController(kyc: KycService) {
  return {
    getOverview: validated({}, async (_input, req, res) => {
      res.json(success({ kyc: await kyc.getOverview(authOf(req).userId) }));
    }),

    submitTier1: validated({ body: tier1Body }, async ({ body }, req, res) => {
      const overview = await kyc.submitTier1(
        authOf(req).userId,
        body.dateOfBirth,
        auditContextFrom(req),
      );
      res.json(success({ kyc: overview }));
    }),

    submitTier2: validated({ body: tier2Body }, async ({ body }, req, res) => {
      const overview = await kyc.submitTier2(authOf(req).userId, body, auditContextFrom(req));
      res.json(success({ kyc: overview }));
    }),

    uploadDocument: validated({ params: documentParams }, async ({ params }, req, res) => {
      // express.raw() only fills the body for the allowed Content-Types.
      if (!Buffer.isBuffer(req.body)) {
        throw new UnsupportedMediaTypeError(
          'Send the file as the request body with Content-Type image/jpeg, image/png or application/pdf.',
        );
      }
      const document = await kyc.uploadDocument(
        authOf(req).userId,
        params.type,
        req.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
        req.body,
        auditContextFrom(req),
      );
      res.status(201).json(success({ document }));
    }),

    submitTier3: validated({ body: tier3Body }, async ({ body }, req, res) => {
      const overview = await kyc.submitTier3(authOf(req).userId, body, auditContextFrom(req));
      res.status(202).json(success({ kyc: overview }));
    }),
  };
}
