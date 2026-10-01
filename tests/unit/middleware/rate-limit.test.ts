import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import {
  ipSubject,
  MemoryRateLimitStore,
  RATE_LIMIT_SCRIPT,
  rateLimit,
  RedisRateLimitStore,
  type RateLimitPolicy,
  type RateLimitStore,
} from '../../../src/middleware/rate-limit.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';

function appWith(store: RateLimitStore, policy: RateLimitPolicy) {
  const app = express();
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use(rateLimit(store, policy));
  app.use(
    Router().get('/ping', (_req, res) => {
      res.json({ data: 'pong' });
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('ipSubject', () => {
  it.each([
    ['203.0.113.7', 'ip:203.0.113.7'],
    ['::ffff:203.0.113.7', 'ip:203.0.113.7'],
    ['2001:db8:85a3:1:abcd:ef01:2345:6789', 'ip6:2001:0db8:85a3:0001::/64'],
    ['2001:DB8:85A3:1::1', 'ip6:2001:0db8:85a3:0001::/64'],
    ['::1', 'ip6:0000:0000:0000:0000::/64'],
    ['fe80::1%eth0', 'ip6:fe80:0000:0000:0000::/64'],
    [undefined, 'ip:unknown'],
  ])('%s → %s', (ip, subject) => {
    expect(ipSubject(ip)).toBe(subject);
  });

  it('puts every address in the same IPv6 /64 into one bucket', () => {
    expect(ipSubject('2001:db8:1:2::a')).toBe(ipSubject('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(ipSubject('2001:db8:1:2::a')).not.toBe(ipSubject('2001:db8:1:3::a'));
  });
});

describe('MemoryRateLimitStore', () => {
  it('counts hits within a window and resets after it', async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);

    expect(await store.hit('k', 60_000)).toEqual({ count: 1, resetMs: 60_000 });
    now += 15_000;
    expect(await store.hit('k', 60_000)).toEqual({ count: 2, resetMs: 45_000 });
    now += 45_000;
    expect(await store.hit('k', 60_000)).toEqual({ count: 1, resetMs: 60_000 });
  });

  it('keeps keys independent', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('a', 1_000);

    expect((await store.hit('b', 1_000)).count).toBe(1);
  });
});

describe('RedisRateLimitStore', () => {
  it('runs the atomic script with one key and the window', async () => {
    const evalFn = vi.fn().mockResolvedValue([3, 42_000]);
    const store = new RedisRateLimitStore({ eval: evalFn });

    await expect(store.hit('rl:api:ip:1.2.3.4', 60_000)).resolves.toEqual({
      count: 3,
      resetMs: 42_000,
    });
    expect(evalFn).toHaveBeenCalledWith(RATE_LIMIT_SCRIPT, 1, 'rl:api:ip:1.2.3.4', 60_000);
  });

  it('rejects an unexpected reply instead of guessing', async () => {
    const store = new RedisRateLimitStore({ eval: vi.fn().mockResolvedValue('OK') });

    await expect(store.hit('k', 1_000)).rejects.toThrow('Unexpected rate limit script reply');
  });
});

describe('rateLimit middleware', () => {
  const policy: RateLimitPolicy = { name: 'test', limit: 2, windowMs: 60_000 };

  it('sets RateLimit headers on allowed requests', async () => {
    const res = await request(appWith(new MemoryRateLimitStore(), policy)).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['ratelimit-remaining']).toBe('1');
    expect(res.headers['ratelimit-reset']).toBe('60');
  });

  it('answers 429 with Retry-After once the limit is exceeded', async () => {
    const app = appWith(new MemoryRateLimitStore(), policy);
    await request(app).get('/ping');
    await request(app).get('/ping');

    const res = await request(app).get('/ping');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(res.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('limits each subject separately', async () => {
    const app = appWith(new MemoryRateLimitStore(), {
      ...policy,
      limit: 1,
      key: (req) => req.get('X-User') ?? 'anon',
    });
    await request(app).get('/ping').set('X-User', 'alice');

    const bob = await request(app).get('/ping').set('X-User', 'bob');
    const alice = await request(app).get('/ping').set('X-User', 'alice');

    expect(bob.status).toBe(200);
    expect(alice.status).toBe(429);
  });

  it('prefixes keys with the policy name so policies never share a counter', async () => {
    const keys: string[] = [];
    const store: RateLimitStore = {
      hit: (key) => {
        keys.push(key);
        return Promise.resolve({ count: 1, resetMs: 1_000 });
      },
    };

    await request(appWith(store, { ...policy, name: 'auth-login' })).get('/ping');

    expect(keys[0]).toMatch(/^rl:auth-login:ip/);
  });

  const broken: RateLimitStore = {
    hit: () =>
      Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false")),
  };

  it('fails open by default when the store is unreachable', async () => {
    const res = await request(appWith(broken, policy)).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers).not.toHaveProperty('ratelimit-limit');
  });

  it('fails closed with a generic 503 when the policy says so', async () => {
    const res = await request(appWith(broken, { ...policy, failOpen: false })).get('/ping');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'An unexpected error occurred.' },
    });
    expect(res.text).not.toContain('enableOfflineQueue');
  });
});
