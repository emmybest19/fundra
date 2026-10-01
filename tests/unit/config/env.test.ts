import { describe, expect, it } from 'vitest';
import { env, EnvValidationError, parseEnv } from '../../../src/config/env.ts';

const valid = {
  DATABASE_URL: 'postgresql://fundra:s3cret-db-pass@localhost:5432/fundra',
  REDIS_URL: 'redis://:s3cret-redis-pass@localhost:6379',
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
    });
  });

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
