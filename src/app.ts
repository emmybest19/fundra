// Builds the Express app: security middleware, routes, error handling.
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
import { createHealthRouter } from './modules/health/health.routes.ts';
import type { HealthService } from './modules/health/health.service.ts';
import { createApiRouter } from './routes/index.ts';

export interface AppDependencies {
  db: PrismaClient;
  health: HealthService;
  /** Redis in production; an in-memory store in tests. */
  rateLimitStore: RateLimitStore;
}

/** Middleware order is deliberate; see docs/ARCHITECTURE.md §5. */
export function createApp({ db, health, rateLimitStore }: AppDependencies): Express {
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
  // Stage 15: the webhooks router mounts here, before JSON parsing (signatures need the raw body).

  app.use(jsonBody);
  app.use('/api/v1', createApiRouter({ db, rateLimitStore }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
