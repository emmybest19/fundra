// Express router for beneficiaries: the signed-in user's saved recipients.
import { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createBeneficiaryController } from './beneficiary.controller.ts';
import type { BeneficiaryService } from './beneficiary.service.ts';

/** Saving looks recipients up (D2 and bank name enquiry): limited against enumeration. */
export const BENEFICIARY_CREATE_RATE_LIMIT: RateLimitPolicy = {
  name: 'beneficiary-create',
  limit: 30,
  windowMs: 60 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface BeneficiaryRouterDependencies {
  beneficiaries: BeneficiaryService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createBeneficiaryRouter({
  beneficiaries,
  authenticate,
  rateLimitStore,
}: BeneficiaryRouterDependencies): Router {
  const controller = createBeneficiaryController(beneficiaries);
  const router = Router();

  router.use(authenticate);
  router.get('/', controller.list);
  router.get('/:id', controller.get);
  // Saving needs a verified account, like sending money; viewing and deleting don't.
  router.post(
    '/',
    requireActiveAccount,
    rateLimit(rateLimitStore, BENEFICIARY_CREATE_RATE_LIMIT),
    controller.create,
  );
  router.patch('/:id', controller.update);
  router.delete('/:id', controller.remove);

  return router;
}
