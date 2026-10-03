// Express router for auth.
import { Router } from 'express';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createAuthController } from './auth.controller.ts';
import type { AuthService } from './auth.service.ts';

const MINUTE = 60 * 1_000;

/** Stops scripted mass sign-ups from one address. */
export const REGISTER_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-register',
  limit: 10,
  windowMs: 60 * MINUTE,
};

/**
 * Per-IP cap on password guessing across many accounts. Guessing one account is also capped
 * by the per-account lockout (5 failures → 15 minutes).
 */
export const LOGIN_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-login',
  limit: 20,
  windowMs: 15 * MINUTE,
};

/** Access tokens last 15 minutes, so legitimate clients refresh a few times an hour. */
export const REFRESH_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-refresh',
  limit: 60,
  windowMs: 15 * MINUTE,
};

export interface AuthRouterDependencies {
  auth: AuthService;
  rateLimitStore: RateLimitStore;
}

export function createAuthRouter({ auth, rateLimitStore }: AuthRouterDependencies): Router {
  const controller = createAuthController(auth);
  const router = Router();

  router.post('/register', rateLimit(rateLimitStore, REGISTER_RATE_LIMIT), controller.register);
  router.post('/login', rateLimit(rateLimitStore, LOGIN_RATE_LIMIT), controller.login);
  router.post('/refresh', rateLimit(rateLimitStore, REFRESH_RATE_LIMIT), controller.refresh);
  router.post('/logout', rateLimit(rateLimitStore, REFRESH_RATE_LIMIT), controller.logout);

  return router;
}
