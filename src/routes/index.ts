// Mounts all module routers under /api/v1.
import { Router } from 'express';
import { env } from '../config/env.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { createAuthenticate } from '../middleware/auth.middleware.ts';
import type { RateLimitStore } from '../middleware/rate-limit.middleware.ts';
import { createAuthRouter } from '../modules/auth/auth.routes.ts';
import { AuthService } from '../modules/auth/auth.service.ts';
import { SessionService } from '../modules/auth/session.service.ts';
import { TokenService } from '../modules/auth/tokens.ts';

export interface ApiDependencies {
  db: PrismaClient;
  rateLimitStore: RateLimitStore;
}

export function createApiRouter({ db, rateLimitStore }: ApiDependencies): Router {
  const tokens = new TokenService(env.JWT_ACCESS_SECRET);
  const authenticate = createAuthenticate({ db, tokens });
  const router = Router();

  router.use(
    '/auth',
    createAuthRouter({
      auth: new AuthService(db, tokens),
      sessions: new SessionService(db),
      authenticate,
      rateLimitStore,
    }),
  );

  return router;
}
