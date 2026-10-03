// Verifies JWT access tokens and the session behind them, and enforces permissions.
import type { Request, RequestHandler } from 'express';
import {
  hasPermissions,
  isRoleName,
  type Permission,
  type RoleName,
} from '../common/constants/rbac.ts';
import {
  ErrorCode,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from '../common/errors/index.ts';
import type { PrismaClient, User } from '../generated/prisma/client.ts';
import { AccessTokenError, type TokenService } from '../modules/auth/tokens.ts';

export interface AuthContext {
  userId: string;
  sessionId: string;
  /** Loaded from the database on every request, so role changes apply immediately. */
  roles: readonly RoleName[];
  status: User['status'];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`; read it with `authOf(req)`. */
    auth?: AuthContext;
  }
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/;

const unauthenticated = (message: string) =>
  new UnauthorizedError(message, { code: ErrorCode.UNAUTHENTICATED });

export interface AuthenticateDependencies {
  db: PrismaClient;
  tokens: TokenService;
}

/**
 * Requires a valid access token **and** a live session behind it.
 *
 * The session is checked on every request (one primary-key lookup that also loads the user
 * and their roles), so logout, remote sign-out, theft revocation and role changes take effect
 * immediately rather than when the 15-minute access token expires. The same lookup rejects
 * suspended users and tokens issued before the user's last password change.
 */
export function createAuthenticate({ db, tokens }: AuthenticateDependencies): RequestHandler {
  return async (req, res, next) => {
    // RFC 6750: tell clients which scheme to use on every 401 from here.
    res.set('WWW-Authenticate', 'Bearer realm="fundra"');

    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (token === undefined) {
      throw unauthenticated('Authentication is required. Send "Authorization: Bearer <token>".');
    }

    let claims;
    try {
      claims = await tokens.verifyAccessToken(token);
    } catch (err) {
      if (err instanceof AccessTokenError && err.reason === 'expired') {
        throw new UnauthorizedError('The access token has expired. Refresh it and retry.', {
          code: ErrorCode.ACCESS_TOKEN_EXPIRED,
          cause: err,
        });
      }
      throw unauthenticated('The access token is invalid.');
    }

    const session = await db.session.findUnique({
      where: { id: claims.sessionId },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: {
          select: {
            status: true,
            passwordChangedAt: true,
            roles: { select: { role: { select: { name: true } } } },
          },
        },
      },
    });
    if (
      session?.userId !== claims.userId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw unauthenticated('This session has ended. Please sign in again.');
    }
    // JWT iat has whole-second precision; compare at that precision.
    if (
      Math.floor(session.user.passwordChangedAt.getTime() / 1_000) * 1_000 >
      claims.issuedAt.getTime()
    ) {
      throw unauthenticated('Your password was changed. Please sign in again.');
    }
    if (session.user.status === 'SUSPENDED' || session.user.status === 'DEACTIVATED') {
      throw new ForbiddenError('This account is not active. Contact support.', {
        code: ErrorCode.ACCOUNT_DISABLED,
      });
    }

    res.removeHeader('WWW-Authenticate');
    req.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      // Unknown role names in the database (e.g. a retired role) grant nothing.
      roles: session.user.roles.map((r) => r.role.name).filter(isRoleName),
      status: session.user.status,
    };
    next();
  };
}

/** The authenticated caller. Only valid on routes behind `authenticate`. */
export function authOf(req: Request): AuthContext {
  if (req.auth === undefined) {
    // A route was mounted without `authenticate`: a programming error, not a client error.
    throw new InternalError('authOf() used on a route without authenticate');
  }
  return req.auth;
}

/**
 * Requires **every** listed permission (from the caller's roles; see common/constants/rbac.ts).
 * Mount after `authenticate`. Permissions are typed, so a misspelled one doesn't compile.
 * Denials are logged with the missing permissions but not revealed to the client.
 */
export function authorize(...required: [Permission, ...Permission[]]): RequestHandler {
  return (req, _res, next) => {
    const { userId, roles } = authOf(req);
    if (!hasPermissions(roles, required)) {
      req.log.warn({ userId, roles, required }, 'permission denied');
      throw new ForbiddenError('You do not have permission to perform this action.', {
        code: ErrorCode.FORBIDDEN,
      });
    }
    next();
  };
}

/**
 * Requires a fully verified account (email and phone, Stage 7 item 4). Money endpoints use
 * this: a PENDING_VERIFICATION user can sign in and verify, but not move money.
 */
export const requireActiveAccount: RequestHandler = (req, _res, next) => {
  if (authOf(req).status !== 'ACTIVE') {
    throw new ForbiddenError('Verify your email and phone number to continue.', {
      code: ErrorCode.ACCOUNT_NOT_ACTIVE,
    });
  }
  next();
};
