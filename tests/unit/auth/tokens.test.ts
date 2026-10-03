import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenError,
  generateRefreshToken,
  hashRefreshToken,
  TokenService,
} from '../../../src/modules/auth/tokens.ts';

const SECRET = 'unit-test-secret-at-least-32-characters-long';
const claims = { userId: 'user-1', sessionId: 'session-1', roles: ['USER'] };

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (err) {
    return err instanceof AccessTokenError ? err.reason : `unexpected: ${String(err)}`;
  }
}

describe('TokenService access tokens', () => {
  it('signs and verifies a token round trip', async () => {
    const now = Date.UTC(2026, 9, 3, 9, 0, 0);
    const tokens = new TokenService(SECRET, () => now);

    const { token, expiresAt } = await tokens.signAccessToken(claims);
    const verified = await tokens.verifyAccessToken(token);

    expect(verified).toEqual({
      ...claims,
      issuedAt: new Date(now),
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1_000),
    });
    expect(expiresAt.getTime() - now).toBe(15 * 60 * 1_000);
  });

  it('rejects an expired token as "expired"', async () => {
    let now = Date.now();
    const tokens = new TokenService(SECRET, () => now);
    const { token } = await tokens.signAccessToken(claims);

    now += (ACCESS_TOKEN_TTL_SECONDS + 1) * 1_000;

    expect(await reasonOf(tokens.verifyAccessToken(token))).toBe('expired');
  });

  it('rejects a token signed with a different key', async () => {
    const { token } = await new TokenService(
      'another-secret-also-32-characters-long!',
    ).signAccessToken(claims);

    expect(await reasonOf(new TokenService(SECRET).verifyAccessToken(token))).toBe('invalid');
  });

  it('rejects a tampered payload (e.g. a user adding an admin role)', async () => {
    const tokens = new TokenService(SECRET);
    const { token } = await tokens.signAccessToken(claims);
    const [header = '', , signature = ''] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'user-1', sid: 'session-1', roles: ['SUPER_ADMIN'] }),
    ).toString('base64url');

    expect(await reasonOf(tokens.verifyAccessToken(`${header}.${forged}.${signature}`))).toBe(
      'invalid',
    );
  });

  it('rejects alg "none" (unsigned tokens)', async () => {
    const tokens = new TokenService(SECRET);
    const { token } = await tokens.signAccessToken(claims);
    const payload = token.split('.')[1] ?? '';
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );

    expect(await reasonOf(tokens.verifyAccessToken(`${unsignedHeader}.${payload}.`))).toBe(
      'invalid',
    );
  });

  it('rejects a correctly signed token for another issuer or audience', async () => {
    const key = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1_000);
    const foreign = await new SignJWT({ sid: 's', roles: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer('someone-else')
      .setAudience('someone-else')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key);

    expect(await reasonOf(new TokenService(SECRET).verifyAccessToken(foreign))).toBe('invalid');
  });

  it('rejects garbage', async () => {
    expect(await reasonOf(new TokenService(SECRET).verifyAccessToken('not.a.jwt'))).toBe('invalid');
  });
});

describe('refresh tokens', () => {
  it('are prefixed, high-entropy and unique', () => {
    const tokens = Array.from({ length: 50 }, () => generateRefreshToken().token);

    for (const token of tokens) expect(token).toMatch(/^fnd_rt_[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(50);
  });

  it('are stored only as a SHA-256 hash that matches the database CHECK', () => {
    const { token, hash } = generateRefreshToken();

    expect(hash).toBe(hashRefreshToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });
});
