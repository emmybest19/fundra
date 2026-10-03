// Express router for auth.
import { Router, type RequestHandler } from 'express';
import {
  rateLimit,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../middleware/rate-limit.middleware.ts';
import { createAuthController } from './auth.controller.ts';
import type { AuthService } from './auth.service.ts';
import type { PasswordResetService } from './password-reset.service.ts';
import type { SessionService } from './session.service.ts';
import type { VerificationService } from './verification.service.ts';

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

/** Code requests and checks: OTP attempts are also capped per code (5) and per send (60 s cooldown). */
export const OTP_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-otp',
  limit: 10,
  windowMs: 15 * MINUTE,
};

/** Password reset is a takeover target: keep it tight. */
export const PASSWORD_RESET_RATE_LIMIT: RateLimitPolicy = {
  name: 'auth-password-reset',
  limit: 5,
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
  sessions: SessionService;
  verification: VerificationService;
  passwordReset: PasswordResetService;
  authenticate: RequestHandler;
  rateLimitStore: RateLimitStore;
}

export function createAuthRouter({
  auth,
  sessions,
  verification,
  passwordReset,
  authenticate,
  rateLimitStore,
}: AuthRouterDependencies): Router {
  const controller = createAuthController({ auth, sessions, verification, passwordReset });
  const otpLimit = rateLimit(rateLimitStore, OTP_RATE_LIMIT);
  const resetLimit = rateLimit(rateLimitStore, PASSWORD_RESET_RATE_LIMIT);
  const router = Router();

  // Public
  router.post('/register', rateLimit(rateLimitStore, REGISTER_RATE_LIMIT), controller.register);
  router.post('/login', rateLimit(rateLimitStore, LOGIN_RATE_LIMIT), controller.login);
  router.post('/refresh', rateLimit(rateLimitStore, REFRESH_RATE_LIMIT), controller.refresh);
  router.post('/logout', rateLimit(rateLimitStore, REFRESH_RATE_LIMIT), controller.logout);
  router.post('/password/forgot', resetLimit, controller.forgotPassword);
  router.post('/password/reset', resetLimit, controller.resetPassword);

  // Email & phone verification (authenticated)
  router.post('/verify/email/request', authenticate, otpLimit, controller.requestEmailCode);
  router.post('/verify/email/confirm', authenticate, otpLimit, controller.confirmEmailCode);
  router.post('/verify/phone/request', authenticate, otpLimit, controller.requestPhoneCode);
  router.post('/verify/phone/confirm', authenticate, otpLimit, controller.confirmPhoneCode);

  // Signed-in devices (authenticated)
  router.get('/sessions', authenticate, controller.listSessions);
  router.delete('/sessions', authenticate, controller.revokeOtherSessions);
  router.delete('/sessions/:id', authenticate, controller.revokeSession);

  return router;
}
