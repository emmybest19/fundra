// Express router for kyc. Every route acts on the signed-in user; reviewers act through the
// admin module (Stage 19).
import express, { Router, type Request, type RequestHandler } from 'express';
import { authOf, requireActiveAccount } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { KYC_DOCUMENT_MAX_BYTES, KYC_DOCUMENT_MIME_TYPES } from './document-file.ts';
import { createKycController } from './kyc.controller.ts';
import type { KycService } from './kyc.service.ts';

/**
 * BVN/NIN checks per user. Each one is a paid provider call, and repeated tries could be used
 * to probe whose number is whose.
 */
export const IDENTITY_CHECK_RATE_LIMIT: RateLimitPolicy = {
  name: 'kyc-identity',
  limit: 5,
  windowMs: 24 * 60 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

/** Uploads per user: each one writes up to 5 MB to storage. */
export const DOCUMENT_UPLOAD_RATE_LIMIT: RateLimitPolicy = {
  name: 'kyc-upload',
  limit: 20,
  windowMs: 60 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface KycRouterDependencies {
  kyc: KycService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createKycRouter({
  kyc,
  authenticate,
  rateLimitStore,
}: KycRouterDependencies): Router {
  const controller = createKycController(kyc);
  const router = Router();

  router.use(authenticate);
  // Reading the status is fine before contacts are verified; applying isn't (Tier 1 needs them).
  router.get('/', controller.getOverview);

  router.post('/tier-1', requireActiveAccount, controller.submitTier1);
  router.post(
    '/tier-2',
    requireActiveAccount,
    rateLimit(rateLimitStore, IDENTITY_CHECK_RATE_LIMIT),
    controller.submitTier2,
  );
  router.put(
    '/documents/:type',
    requireActiveAccount,
    rateLimit(rateLimitStore, DOCUMENT_UPLOAD_RATE_LIMIT),
    // Only on this route, and only for the allowed types; everything else stays JSON-only.
    express.raw({ type: [...KYC_DOCUMENT_MIME_TYPES], limit: KYC_DOCUMENT_MAX_BYTES }),
    controller.uploadDocument,
  );
  router.post('/tier-3', requireActiveAccount, controller.submitTier3);

  return router;
}
