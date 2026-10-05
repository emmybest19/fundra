import { describe, expect, it } from 'vitest';
import { env, EnvValidationError, parseEnv } from '../../../src/config/env.ts';

const valid = {
  DATABASE_URL: 'postgresql://fundra:s3cret-db-pass@localhost:5432/fundra',
  REDIS_URL: 'redis://:s3cret-redis-pass@localhost:6379',
  JWT_ACCESS_SECRET: 'a-test-secret-that-is-at-least-32-chars-long',
  OTP_SECRET: 'another-test-secret-at-least-32-characters',
  KYC_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  KYC_HMAC_KEY: 'a-kyc-hmac-test-secret-at-least-32-characters',
};

function issuesFor(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const result = parseEnv(valid);

    expect(result).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: valid.DATABASE_URL,
      REDIS_URL: valid.REDIS_URL,
      CORS_ORIGINS: [],
      TRUST_PROXY_HOPS: 0,
      JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET,
      OTP_SECRET: valid.OTP_SECRET,
      KYC_PROVIDER: 'mock',
      KYC_ENCRYPTION_KEY: valid.KYC_ENCRYPTION_KEY,
      KYC_HMAC_KEY: valid.KYC_HMAC_KEY,
      KYC_STORAGE_DIR: 'storage/kyc',
    });
  });

  it('parses CORS_ORIGINS as a trimmed list of origins', () => {
    const result = parseEnv({
      ...valid,
      CORS_ORIGINS: ' https://app.fundra.dev , http://localhost:5173,',
    });

    expect(result.CORS_ORIGINS).toEqual(['https://app.fundra.dev', 'http://localhost:5173']);
  });

  it.each(['https://app.fundra.dev/', 'https://app.fundra.dev/path', 'ftp://files.dev', '*'])(
    'rejects CORS_ORIGINS entry %s',
    (origin) => {
      expect(issuesFor({ ...valid, CORS_ORIGINS: origin })[0]).toMatch(/^CORS_ORIGINS/);
    },
  );

  it('coerces PORT to a number', () => {
    expect(parseEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(valid))).toBe(true);
  });

  it('ignores unrelated variables', () => {
    expect(parseEnv({ ...valid, PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('reports every missing required variable by name', () => {
    const issues = issuesFor({});

    expect(issues.some((issue) => issue.startsWith('DATABASE_URL:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('REDIS_URL:'))).toBe(true);
  });

  it('treats empty values as missing', () => {
    const issues = issuesFor({ ...valid, DATABASE_URL: '   ' });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^DATABASE_URL:/);
  });

  it.each([
    ['DATABASE_URL', 'mysql://user:pass@localhost/fundra'],
    ['DATABASE_URL', 'not a url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['TRUST_PROXY_HOPS', 'true'],
    ['JWT_ACCESS_SECRET', 'too-short-secret'],
    ['OTP_SECRET', 'too-short-secret'],
    ['KYC_PROVIDER', 'smileid'],
    ['KYC_ENCRYPTION_KEY', Buffer.alloc(16, 1).toString('base64')],
    ['KYC_ENCRYPTION_KEY', 'not base64 at all, but long enough to be 32+ characters'],
    ['KYC_HMAC_KEY', 'too-short-secret'],
  ])('rejects invalid %s=%s', (name, value) => {
    const issues = issuesFor({ ...valid, [name]: value });

    expect(issues.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
  });

  it('never includes variable values in the error message', () => {
    const secret = 'super-secret-password-123';

    try {
      parseEnv({ DATABASE_URL: `mysql://admin:${secret}@db/fundra`, REDIS_URL: valid.REDIS_URL });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('env', () => {
  it('is parsed from process.env at import time', () => {
    expect(env.NODE_ENV).toBe('test');
    expect(Object.isFrozen(env)).toBe(true);
  });
});
