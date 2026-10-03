// HTTP layer for auth: parse request, call service, shape response.
import type { Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { toPublicUser } from '../users/user.types.ts';
import { loginBody, refreshTokenBody, registerBody } from './auth.schema.ts';
import type { AuthService, IssuedTokens } from './auth.service.ts';

function tokenResponse(tokens: IssuedTokens) {
  return {
    tokenType: 'Bearer' as const,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}

/** Responses carrying tokens must never be cached by browsers or proxies. */
function noStore(res: Response): Response {
  return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

export function createAuthController(auth: AuthService) {
  return {
    register: validated({ body: registerBody }, async ({ body }, req, res) => {
      const user = await auth.register(body, auditContextFrom(req));
      res.status(201).json(success({ user: toPublicUser(user) }));
    }),

    login: validated({ body: loginBody }, async ({ body }, req, res) => {
      const { user, tokens } = await auth.login(body, auditContextFrom(req));
      noStore(res).json(success({ ...tokenResponse(tokens), user: toPublicUser(user) }));
    }),

    refresh: validated({ body: refreshTokenBody }, async ({ body }, req, res) => {
      const tokens = await auth.refresh(body.refreshToken, auditContextFrom(req));
      noStore(res).json(success(tokenResponse(tokens)));
    }),

    logout: validated({ body: refreshTokenBody }, async ({ body }, req, res) => {
      await auth.logout(body.refreshToken, auditContextFrom(req));
      res.status(204).end();
    }),
  };
}
