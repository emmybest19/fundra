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
import type { DocumentStorage } from '../modules/kyc/document-storage.ts';
import { IdentityNumberCrypto } from '../modules/kyc/identity-crypto.ts';
import { createKycRouter } from '../modules/kyc/kyc.routes.ts';
import { KycService } from '../modules/kyc/kyc.service.ts';
import type { KycProvider } from '../modules/kyc/providers/kyc-provider.ts';
import type { MessageSender } from '../modules/notifications/notification.types.ts';
import { createUserRouter } from '../modules/users/user.routes.ts';
import { UserService } from '../modules/users/user.service.ts';
import { createWalletRouter } from '../modules/wallets/wallet.routes.ts';
import { WalletService } from '../modules/wallets/wallet.service.ts';

export interface ApiDependencies {
  db: PrismaClient;
  rateLimitStore: RateLimitStore;
  otpStore: OtpStore;
  messageSender: MessageSender;
  kycProvider: KycProvider;
  documentStorage: DocumentStorage;
}

export function createApiRouter({
  db,
  rateLimitStore,
  otpStore,
  messageSender,
  kycProvider,
  documentStorage,
}: ApiDependencies): Router {
  const tokens = new TokenService(env.JWT_ACCESS_SECRET);
  const otp = new OtpService(otpStore, env.OTP_SECRET);
  const authenticate = createAuthenticate({ db, tokens });
  const auth = new AuthService(db, tokens, messageSender);
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
      passwords: auth,
      authenticate,
      rateLimitStore,
    }),
  );

  router.use(
    '/kyc',
    createKycRouter({
      kyc: new KycService(
        db,
        kycProvider,
        documentStorage,
        new IdentityNumberCrypto(env.KYC_ENCRYPTION_KEY, env.KYC_HMAC_KEY),
      ),
      authenticate,
      rateLimitStore,
    }),
  );

  router.use('/wallets', createWalletRouter({ wallets: new WalletService(db), authenticate }));

  return router;
}
