// Mounts all module routers under /api/v1.
import { Router } from 'express';
import { env } from '../config/env.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { createAuthenticate } from '../middleware/auth.middleware.ts';
import type { RateLimitStore } from '../middleware/rate-limit.middleware.ts';
import { createAuthRouter } from '../modules/auth/auth.routes.ts';
import { AuthService } from '../modules/auth/auth.service.ts';
import { OtpService, type OtpStore } from '../modules/auth/otp.ts';
import { PasswordResetService } from '../modules/auth/password-reset.service.ts';
import { SessionService } from '../modules/auth/session.service.ts';
import { TokenService } from '../modules/auth/tokens.ts';
import { VerificationService } from '../modules/auth/verification.service.ts';
import type { MessageSender } from '../modules/notifications/notification.types.ts';
import { createUserRouter } from '../modules/users/user.routes.ts';
import { UserService } from '../modules/users/user.service.ts';

export interface ApiDependencies {
  db: PrismaClient;
  rateLimitStore: RateLimitStore;
  otpStore: OtpStore;
  messageSender: MessageSender;
}

export function createApiRouter({
  db,
  rateLimitStore,
  otpStore,
  messageSender,
}: ApiDependencies): Router {
  const tokens = new TokenService(env.JWT_ACCESS_SECRET);
  const otp = new OtpService(otpStore, env.OTP_SECRET);
  const authenticate = createAuthenticate({ db, tokens });
  const auth = new AuthService(db, tokens);
  const router = Router();

  router.use(
    '/auth',
    createAuthRouter({
      auth,
      sessions: new SessionService(db),
      verification: new VerificationService(db, otp, messageSender),
      passwordReset: new PasswordResetService(db, otp, messageSender),
      authenticate,
      rateLimitStore,
    }),
  );

  router.use(
    '/users',
    createUserRouter({
      users: new UserService(db, auth, otp, messageSender),
      authenticate,
      rateLimitStore,
    }),
  );

  return router;
}
