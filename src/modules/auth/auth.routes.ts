// Express router for auth.
import { Router } from 'express';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createAuthController } from './auth.controller.ts';
import type { AuthService } from './auth.service.ts';

/** Stops scripted mass sign-ups from one address. */
export const REGISTER_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-register',
  limit: 10,
  windowMs: 60 * 60 * 1_000,
};

export interface AuthRouterDependencies {
  auth: AuthService;
  rateLimitStore: RateLimitStore;
}

export function createAuthRouter({ auth, rateLimitStore }: AuthRouterDependencies): Router {
  const controller = createAuthController(auth);
  const router = Router();

  router.post('/register', rateLimit(rateLimitStore, REGISTER_RATE_LIMIT), controller.register);

  return router;
}
