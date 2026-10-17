// Builds the Express app: security middleware, routes, error handling.
import type { Queue } from 'bullmq';
import express, { type Express } from 'express';
import { env } from './config/env.ts';
import type { PrismaClient } from './generated/prisma/client.ts';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.ts';
import {
  API_RATE_LIMIT,
  rateLimit,
  type RateLimitStore,
} from './middleware/rate-limit.middleware.ts';
import { requestId } from './middleware/request-id.middleware.ts';
import { requestLogger } from './middleware/request-logger.middleware.ts';
import { corsPolicy, jsonBody, securityHeaders } from './middleware/security.middleware.ts';
import type { OtpStore } from './modules/auth/otp.ts';
import type { DocumentStorage } from './modules/kyc/document-storage.ts';
import type { KycProvider } from './modules/kyc/providers/kyc-provider.ts';
import type { PaymentProvider } from './modules/payments/providers/payment-provider.ts';
import { createHealthRouter } from './modules/health/health.routes.ts';
import type { HealthService } from './modules/health/health.service.ts';
import type { MessageSender } from './modules/notifications/notification.types.ts';
import { createWebhookProcessor } from './modules/webhooks/webhook.processor.ts';
import type { WebhookQueue } from './modules/webhooks/webhook.controller.ts';
import { createWebhookRouter } from './modules/webhooks/webhook.routes.ts';
import { WebhookService } from './modules/webhooks/webhook.service.ts';
import { createDocsRouters } from './docs/docs.routes.ts';
import { createApiRouter } from './routes/index.ts';

export interface AppDependencies {
  db: PrismaClient;
  health: HealthService;
  /** Redis in production; an in-memory store in tests. */
  rateLimitStore: RateLimitStore;
  /** Redis in production; in memory in tests. */
  otpStore: OtpStore;
  /** Email/SMS delivery (Stage 17); in memory until then and in tests. */
  messageSender: MessageSender;
  /** Identity verification (Stage 9); the mock until a sandbox provider is added. */
  kycProvider: KycProvider;
  /** KYC document files: local disk now, S3 later; in memory in tests. */
  documentStorage: DocumentStorage;
  /** Deposits and withdrawals (Stage 14); the mock until a sandbox provider is added. */
  paymentProvider: PaymentProvider;
  /** The BullMQ `webhooks` queue (Stage 16): webhook processing is handed to the worker. */
  webhookQueue: WebhookQueue;
  /** The BullMQ `maintenance` queue: statement generation is handed to the worker. */
  maintenanceQueue: Pick<Queue, 'add'>;
  /** Generated statements: local disk now, S3 later; in memory in tests. */
  statementStorage: DocumentStorage;
}

/** Shown in the OpenAPI document. */
export const API_VERSION = '1.0.0';

/** Middleware order is deliberate; see docs/ARCHITECTURE.md §5. */
export function createApp({
  db,
  health,
  rateLimitStore,
  otpStore,
  messageSender,
  kycProvider,
  documentStorage,
  paymentProvider,
  webhookQueue,
  maintenanceQueue,
  statementStorage,
}: AppDependencies): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(requestId);
  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(corsPolicy);

  // Probes are never rate limited: throttling them would make healthy instances look dead.
  app.use('/health', createHealthRouter(health));

  // Before body parsing, so rejected requests cost nothing to parse.
  app.use(rateLimit(rateLimitStore, API_RATE_LIMIT));
  // Before JSON parsing: webhook signatures cover the raw bytes (docs/ARCHITECTURE.md §8.6).
  app.use(
    '/api/v1/webhooks',
    createWebhookRouter({
      webhooks: new WebhookService(db, paymentProvider),
      queue: webhookQueue,
      processor: createWebhookProcessor(db, paymentProvider),
    }),
  );

  app.use(jsonBody);
  const docs = createDocsRouters(API_VERSION);
  app.use('/api/v1', docs.openApi);
  app.use('/docs', docs.ui);
  app.use(
    '/api/v1',
    createApiRouter({
      db,
      rateLimitStore,
      otpStore,
      messageSender,
      kycProvider,
      documentStorage,
      paymentProvider,
      maintenanceQueue,
      statementStorage,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
