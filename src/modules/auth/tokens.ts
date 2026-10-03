// Access tokens (signed JWTs) and refresh tokens (opaque, stored only as hashes).
import { createHash, randomBytes } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Absolute session lifetime. Rotating refresh tokens never extends it. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const ISSUER = 'fundra-api';
const AUDIENCE = 'fundra-api';
const ALGORITHM = 'HS256';
/** Recognisable prefix so secret scanners (e.g. GitHub) can flag leaked refresh tokens. */
const REFRESH_TOKEN_PREFIX = 'fnd_rt_';

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  roles: readonly string[];
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  issuedAt: Date;
  expiresAt: Date;
}

export class AccessTokenError extends Error {
  readonly reason: 'expired' | 'invalid';

  constructor(reason: 'expired' | 'invalid', options?: { cause?: unknown }) {
    super(`Access token ${reason}`, options);
    this.name = 'AccessTokenError';
    this.reason = reason;
  }
}

export class TokenService {
  readonly #key: Uint8Array;
  readonly #now: () => number;

  constructor(secret: string, now: () => number = Date.now) {
    this.#key = new TextEncoder().encode(secret);
    this.#now = now;
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(this.#now() / 1_000);
    const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ sid: claims.sessionId, roles: [...claims.roles] })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.#key);
    return { token, expiresAt: new Date(expiresAt * 1_000) };
  }

  /**
   * Verifies signature, algorithm (HS256 only: `alg: none` and algorithm swaps are refused),
   * issuer, audience and expiry. Used by the authenticate middleware (Stage 7, item 5).
   */
  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date(this.#now()),
      });
      const { sub, sid, roles, iat, exp } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        !Array.isArray(roles) ||
        !roles.every((role) => typeof role === 'string') ||
        typeof iat !== 'number' ||
        typeof exp !== 'number'
      ) {
        throw new AccessTokenError('invalid');
      }
      return {
        userId: sub,
        sessionId: sid,
        roles,
        issuedAt: new Date(iat * 1_000),
        expiresAt: new Date(exp * 1_000),
      };
    } catch (err) {
      if (err instanceof AccessTokenError) throw err;
      throw new AccessTokenError(err instanceof errors.JWTExpired ? 'expired' : 'invalid', {
        cause: err,
      });
    }
  }
}

/** 256 bits of randomness. The plain token goes to the client; only its hash is stored. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256 is enough here (unlike passwords): the input is 256 random bits, so there is
 * nothing to brute-force, and lookups need a deterministic hash.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
