// Express router for users. Every route acts on the signed-in user ("me"); admins manage
// other users through the admin module (Stage 19).
import { Router, type Request, type RequestHandler } from 'express';
import { authOf } from '../../middleware/auth.middleware.ts';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createUserController } from './user.controller.ts';
import type { UserService } from './user.service.ts';

/**
 * Password re-checks, codes sent to new addresses and deactivation, per user. Keyed by user
 * (not IP) because these routes are authenticated: one account can't spread attempts across
 * addresses. Password guessing is also capped by the login lockout (5 failures → 15 min).
 */
export const ACCOUNT_SECURITY_RATE_LIMIT: RateLimitPolicy = {
  name: 'users-security',
  limit: 10,
  windowMs: 15 * 60 * 1_000,
  key: (req: Request) => `user:${authOf(req).userId}`,
};

export interface UserRouterDependencies {
  users: UserService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createUserRouter({
  users,
  authenticate,
  rateLimitStore,
}: UserRouterDependencies): Router {
  const controller = createUserController(users);
  const sensitive = rateLimit(rateLimitStore, ACCOUNT_SECURITY_RATE_LIMIT);
  const router = Router();

  router.use(authenticate);

  router.get('/me', controller.getProfile);
  router.patch('/me', controller.updateProfile);
  router.get('/me/preferences', controller.getPreferences);
  router.patch('/me/preferences', controller.updatePreferences);

  router.post('/me/email', sensitive, controller.requestEmailChange);
  router.post('/me/email/confirm', sensitive, controller.confirmEmailChange);
  router.post('/me/phone', sensitive, controller.requestPhoneChange);
  router.post('/me/phone/confirm', sensitive, controller.confirmPhoneChange);

  router.post('/me/deactivate', sensitive, controller.deactivate);

  return router;
}
