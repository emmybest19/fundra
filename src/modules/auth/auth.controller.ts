// HTTP layer for auth: parse request, call service, shape response.
import type { Response } from 'express';
import { z } from 'zod';
import { success } from '../../common/utils/response.ts';
import { uuid } from '../../common/validators/index.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { toPublicUser } from '../users/user.types.ts';
import {
  confirmCodeBody,
  forgotPasswordBody,
  loginBody,
  refreshTokenBody,
  registerBody,
  resetPasswordBody,
} from './auth.schema.ts';
import type { AuthService, IssuedTokens } from './auth.service.ts';
import type { PasswordResetService } from './password-reset.service.ts';
import type { SessionService } from './session.service.ts';
import type { VerificationChannel, VerificationService } from './verification.service.ts';

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

export interface AuthControllerDependencies {
  auth: AuthService;
  sessions: SessionService;
  verification: VerificationService;
  passwordReset: PasswordResetService;
}

export function createAuthController({
  auth,
  sessions,
  verification,
  passwordReset,
}: AuthControllerDependencies) {
  const requestCode = (channel: VerificationChannel) =>
    validated({}, async (_input, req, res) => {
      await verification.request(authOf(req).userId, channel);
      res.status(202).json(success({ sent: true }));
    });

  const confirmCode = (channel: VerificationChannel) =>
    validated({ body: confirmCodeBody }, async ({ body }, req, res) => {
      const user = await verification.confirm(
        authOf(req).userId,
        channel,
        body.code,
        auditContextFrom(req),
      );
      res.json(success({ user: toPublicUser(user) }));
    });

  return {
    requestEmailCode: requestCode('email'),
    confirmEmailCode: confirmCode('email'),
    requestPhoneCode: requestCode('phone'),
    confirmPhoneCode: confirmCode('phone'),

    forgotPassword: validated({ body: forgotPasswordBody }, async ({ body }, req, res) => {
      await passwordReset.forgot(body.identifier, auditContextFrom(req));
      // Same response whether or not the account exists.
      res.status(202).json(success({ sent: true }));
    }),

    resetPassword: validated({ body: resetPasswordBody }, async ({ body }, req, res) => {
      await passwordReset.reset(
        body.identifier,
        body.code,
        body.newPassword,
        auditContextFrom(req),
      );
      res.status(204).end();
    }),

    listSessions: validated({}, async (_input, req, res) => {
      const { userId, sessionId } = authOf(req);
      res.json(success(await sessions.list(userId, sessionId)));
    }),

    revokeSession: validated(
      { params: z.strictObject({ id: uuid }) },
      async ({ params }, req, res) => {
        await sessions.revoke(authOf(req).userId, params.id, auditContextFrom(req));
        res.status(204).end();
      },
    ),

    revokeOtherSessions: validated({}, async (_input, req, res) => {
      const { userId, sessionId } = authOf(req);
      const revoked = await sessions.revokeOthers(userId, sessionId, auditContextFrom(req));
      res.json(success({ revoked }));
    }),

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
