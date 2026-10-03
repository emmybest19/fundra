// Mounts all module routers under /api/v1.
import { Router } from 'express';
import type { PrismaClient } from '../generated/prisma/client.ts';
import type { RateLimitStore } from '../middleware/rate-limit.middleware.ts';
import { env } from '../config/env.ts';
import { createAuthRouter } from '../modules/auth/auth.routes.ts';
import { AuthService } from '../modules/auth/auth.service.ts';
import { TokenService } from '../modules/auth/tokens.ts';

export interface ApiDependencies {
  db: PrismaClient;
  rateLimitStore: RateLimitStore;
}

export function createApiRouter({ db, rateLimitStore }: ApiDependencies): Router {
  const router = Router();

  const tokens = new TokenService(env.JWT_ACCESS_SECRET);
  router.use('/auth', createAuthRouter({ auth: new AuthService(db, tokens), rateLimitStore }));

  return router;
}
