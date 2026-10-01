// Redis-backed rate limiting per IP / user / route.
import { isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { ServiceUnavailableError, TooManyRequestsError } from '../common/errors/index.ts';

export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/**
 * Fixed window per key, atomic in Redis: INCR and PEXPIRE run as one script, so concurrent
 * requests can't race past the count. A counter that somehow lost its expiry is repaired
 * rather than blocking its subject forever.
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisRateLimitStore implements RateLimitStore {
  readonly #client: Pick<Redis, 'eval'>;

  constructor(client: Pick<Redis, 'eval'>) {
    this.#client = client;
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const reply = await this.#client.eval(RATE_LIMIT_SCRIPT, 1, key, windowMs);
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw new Error('Unexpected rate limit script reply');
    }
    return { count: reply[0], resetMs: reply[1] };
  }
}

/** Same semantics as the Redis store, for tests and local experiments. Not shared across processes. */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.#now();
    const current = this.#windows.get(key);
    const window =
      current === undefined || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    window.count++;
    this.#windows.set(key, window);
    return Promise.resolve({ count: window.count, resetMs: window.resetAt - now });
  }
}

function expandIPv6(address: string): string[] {
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((group) => group.toLowerCase().padStart(4, '0'));
}

/**
 * Rate-limit subject for a client address. IPv6 clients are grouped by /64: a single user
 * usually controls a whole /64 and could otherwise rotate addresses to dodge the limit.
 */
export function ipSubject(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'ip:unknown';
  const mappedIPv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (mappedIPv4 !== undefined) return `ip:${mappedIPv4}`;
  const address = ip.split('%')[0] ?? ip; // drop an IPv6 zone ID such as %eth0
  if (!isIPv6(address)) return `ip:${address}`;
  return `ip6:${expandIPv6(address).slice(0, 4).join(':')}::/64`;
}

export interface RateLimitPolicy {
  /** Short policy name, part of the Redis key, e.g. `api` or `auth-login`. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Who is being limited. Defaults to the client IP (`req.ip`, which honours TRUST_PROXY_HOPS). */
  key?: (req: Request) => string;
  /**
   * When the store is unreachable: `true` (default) lets requests through, so a Redis outage
   * doesn't take the API down; `false` answers 503, for endpoints where abuse costs more
   * than downtime.
   */
  failOpen?: boolean;
}

export function rateLimit(store: RateLimitStore, policy: RateLimitPolicy): RequestHandler {
  const subjectOf = policy.key ?? ((req: Request) => ipSubject(req.ip));
  const failOpen = policy.failOpen ?? true;

  return async (req, res, next) => {
    let hit: RateLimitHit;
    try {
      hit = await store.hit(`rl:${policy.name}:${subjectOf(req)}`, policy.windowMs);
    } catch (err) {
      if (failOpen) {
        // The Redis client already logs the outage once; avoid a log line per request.
        req.log.debug({ err, policy: policy.name }, 'rate limiter unavailable; allowing request');
        next();
        return;
      }
      next(new ServiceUnavailableError(undefined, { cause: err }));
      return;
    }

    const resetSeconds = Math.max(1, Math.ceil(hit.resetMs / 1_000));
    res.set({
      'RateLimit-Limit': String(policy.limit),
      'RateLimit-Remaining': String(Math.max(0, policy.limit - hit.count)),
      'RateLimit-Reset': String(resetSeconds),
    });

    if (hit.count > policy.limit) {
      res.set('Retry-After', String(resetSeconds));
      next(new TooManyRequestsError());
      return;
    }
    next();
  };
}

/** Applied to every route except /health. Per-route policies (login, OTP, transfers) are stricter. */
export const API_RATE_LIMIT: RateLimitPolicy = { name: 'api', limit: 300, windowMs: 60_000 };
