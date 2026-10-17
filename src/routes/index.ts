// Mounts all module routers under /api/v1.
import { Router } from 'express';
import { env } from '../config/env.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { createAuthenticate } from '../middleware/auth.middleware.ts';
import type { RateLimitStore } from '../middleware/rate-limit.middleware.ts';
import { AdminRoleService } from '../modules/admin/admin-roles.service.ts';
import { ReconciliationService } from '../modules/ledger/reconciliation.service.ts';
import { AdminSettingsService } from '../modules/admin/admin-settings.service.ts';
import { createAdminRouter } from '../modules/admin/admin.routes.ts';
import { AdminService } from '../modules/admin/admin.service.ts';
import { TransferReversalService } from '../modules/transfers/transfer-reversal.service.ts';
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
import { DepositService } from '../modules/payments/deposit.service.ts';
import { OutboundPaymentService } from '../modules/payments/outbound-payment.service.ts';
import { createPaymentRouter } from '../modules/payments/payment.routes.ts';
import type { PaymentProvider } from '../modules/payments/providers/payment-provider.ts';
import { createBeneficiaryRouter } from '../modules/beneficiaries/beneficiary.routes.ts';
import { BeneficiaryService } from '../modules/beneficiaries/beneficiary.service.ts';
import { createNotificationRouter } from '../modules/notifications/notification.routes.ts';
import { NotificationFeed } from '../modules/notifications/notification.service.ts';
import type { MessageSender } from '../modules/notifications/notification.types.ts';
import { createUserRouter } from '../modules/users/user.routes.ts';
import { createTransactionRouter } from '../modules/transactions/transaction.routes.ts';
import { TransactionService } from '../modules/transactions/transaction.service.ts';
import { createTransferRouter } from '../modules/transfers/transfer.routes.ts';
import { TransferService } from '../modules/transfers/transfer.service.ts';
import { IdempotencyService } from '../common/idempotency/idempotency.service.ts';
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
  paymentProvider: PaymentProvider;
}

export function createApiRouter({
  db,
  rateLimitStore,
  otpStore,
  messageSender,
  kycProvider,
  documentStorage,
  paymentProvider,
}: ApiDependencies): Router {
  const tokens = new TokenService(env.JWT_ACCESS_SECRET);
  const otp = new OtpService(otpStore, env.OTP_SECRET);
  const authenticate = createAuthenticate({ db, tokens });
  const auth = new AuthService(db, tokens, messageSender);
  const idempotency = new IdempotencyService(db);
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

  const kyc = new KycService(
    db,
    kycProvider,
    documentStorage,
    new IdentityNumberCrypto(env.KYC_ENCRYPTION_KEY, env.KYC_HMAC_KEY),
  );
  router.use(
    '/kyc',
    createKycRouter({
      kyc,
      authenticate,
      rateLimitStore,
    }),
  );

  const wallets = new WalletService(db);
  router.use('/wallets', createWalletRouter({ wallets, authenticate }));

  router.use(
    '/transactions',
    createTransactionRouter({ transactions: new TransactionService(db), authenticate }),
  );

  router.use(
    '/transfers',
    createTransferRouter({
      transfers: new TransferService(db, idempotency),
      authenticate,
      rateLimitStore,
    }),
  );

  router.use(
    '/notifications',
    createNotificationRouter({ feed: new NotificationFeed(db), authenticate }),
  );

  const outbound = new OutboundPaymentService(db, paymentProvider, idempotency);
  router.use(
    '/payments',
    createPaymentRouter({
      deposits: new DepositService(db, paymentProvider, idempotency),
      outbound,
      authenticate,
      rateLimitStore,
    }),
  );

  router.use(
    '/beneficiaries',
    createBeneficiaryRouter({
      beneficiaries: new BeneficiaryService(db, outbound),
      authenticate,
      rateLimitStore,
    }),
  );

  router.use(
    '/admin',
    createAdminRouter({
      admin: new AdminService(db),
      settings: new AdminSettingsService(db),
      kyc,
      wallets,
      reversals: new TransferReversalService(db),
      roles: new AdminRoleService(db),
      reconciliation: new ReconciliationService(db),
      authenticate,
    }),
  );

  return router;
}
