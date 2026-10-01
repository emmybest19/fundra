// Builds the Express app: security middleware, routes, error handling.
import express, { type Express } from 'express';
import { env } from './config/env.ts';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.ts';
import { requestId } from './middleware/request-id.middleware.ts';
import { requestLogger } from './middleware/request-logger.middleware.ts';
import { corsPolicy, jsonBody, securityHeaders } from './middleware/security.middleware.ts';
import { createHealthRouter } from './modules/health/health.routes.ts';
import type { HealthService } from './modules/health/health.service.ts';
import { apiRouter } from './routes/index.ts';

export interface AppDependencies {
  health: HealthService;
}

/** Middleware order is deliberate; see docs/ARCHITECTURE.md §5. */
export function createApp({ health }: AppDependencies): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(requestId);
  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(corsPolicy);

  app.use('/health', createHealthRouter(health));
  // Stage 15: the webhooks router mounts here, before JSON parsing (signatures need the raw body).

  app.use(jsonBody);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
