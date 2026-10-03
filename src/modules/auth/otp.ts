// One-time codes (email/phone verification, password reset), stored in Redis as HMACs.
import { createHmac, randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';

export type OtpPurpose = 'email_verification' | 'phone_verification' | 'password_reset';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1_000;

export type OtpCheckResult = 'ok' | 'mismatch' | 'missing' | 'exhausted';

export interface OtpStore {
  /** Stores (or replaces) the code hash with a fresh attempt counter and TTL. */
  put(key: string, hash: string, ttlMs: number): Promise<void>;
  /**
   * Atomically checks a hash: counts the attempt, deletes the code on success (single use)
   * or once attempts run out.
   */
  check(key: string, hash: string, maxAttempts: number): Promise<OtpCheckResult>;
  /** True if the cooldown was acquired (no code sent recently); false while cooling down. */
  acquireCooldown(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * The whole check in one round trip, so concurrent guesses can't share an attempt.
 * Stored as a Redis hash: { hash, attempts }.
 */
export const OTP_CHECK_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'missing'
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return 'exhausted'
end
if redis.call('HGET', KEYS[1], 'hash') == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'ok'
end
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
end
return 'mismatch'
`;

export class RedisOtpStore implements OtpStore {
  readonly #redis: Pick<Redis, 'multi' | 'eval' | 'set'>;

  constructor(redis: Pick<Redis, 'multi' | 'eval' | 'set'>) {
    this.#redis = redis;
  }

  async put(key: string, hash: string, ttlMs: number): Promise<void> {
    await this.#redis.multi().del(key).hset(key, { hash, attempts: 0 }).pexpire(key, ttlMs).exec();
  }

  async check(key: string, hash: string, maxAttempts: number): Promise<OtpCheckResult> {
    const result = await this.#redis.eval(OTP_CHECK_SCRIPT, 1, key, hash, maxAttempts);
    if (
      result === 'ok' ||
      result === 'mismatch' ||
      result === 'missing' ||
      result === 'exhausted'
    ) {
      return result;
    }
    throw new Error('Unexpected OTP script reply');
  }

  async acquireCooldown(key: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }
}

/** Same semantics as RedisOtpStore, for tests. Not shared across processes. */
export class MemoryOtpStore implements OtpStore {
  readonly #codes = new Map<string, { hash: string; attempts: number; expiresAt: number }>();
  readonly #cooldowns = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  put(key: string, hash: string, ttlMs: number): Promise<void> {
    this.#codes.set(key, { hash, attempts: 0, expiresAt: this.#now() + ttlMs });
    return Promise.resolve();
  }

  check(key: string, hash: string, maxAttempts: number): Promise<OtpCheckResult> {
    const entry = this.#codes.get(key);
    if (entry === undefined || entry.expiresAt <= this.#now()) {
      this.#codes.delete(key);
      return Promise.resolve('missing');
    }
    entry.attempts++;
    if (entry.attempts > maxAttempts) {
      this.#codes.delete(key);
      return Promise.resolve('exhausted');
    }
    if (entry.hash === hash) {
      this.#codes.delete(key);
      return Promise.resolve('ok');
    }
    if (entry.attempts >= maxAttempts) this.#codes.delete(key);
    return Promise.resolve('mismatch');
  }

  acquireCooldown(key: string, ttlMs: number): Promise<boolean> {
    const until = this.#cooldowns.get(key);
    if (until !== undefined && until > this.#now()) return Promise.resolve(false);
    this.#cooldowns.set(key, this.#now() + ttlMs);
    return Promise.resolve(true);
  }
}

export interface IssuedOtp {
  /** Send this to the user. Never log or persist it. */
  code: string;
}

/** Issues and checks codes. Only HMACs reach the store, so a Redis leak exposes no codes. */
export class OtpService {
  readonly #store: OtpStore;
  readonly #secret: string;

  constructor(store: OtpStore, secret: string) {
    this.#store = store;
    this.#secret = secret;
  }

  /** Returns null while the resend cooldown for this user and purpose is active. */
  async issue(purpose: OtpPurpose, userId: string): Promise<IssuedOtp | null> {
    if (
      !(await this.#store.acquireCooldown(
        `otp:cooldown:${purpose}:${userId}`,
        OTP_RESEND_COOLDOWN_MS,
      ))
    ) {
      return null;
    }
    const code = randomInt(0, 10 ** OTP_LENGTH)
      .toString()
      .padStart(OTP_LENGTH, '0');
    await this.#store.put(
      this.#key(purpose, userId),
      this.#hash(purpose, userId, code),
      OTP_TTL_MS,
    );
    return { code };
  }

  check(purpose: OtpPurpose, userId: string, code: string): Promise<OtpCheckResult> {
    return this.#store.check(
      this.#key(purpose, userId),
      this.#hash(purpose, userId, code),
      OTP_MAX_ATTEMPTS,
    );
  }

  #key(purpose: OtpPurpose, userId: string): string {
    return `otp:${purpose}:${userId}`;
  }

  /** Bound to purpose and user, so a code issued for one can never verify the other. */
  #hash(purpose: OtpPurpose, userId: string, code: string): string {
    return createHmac('sha256', this.#secret).update(`${purpose}:${userId}:${code}`).digest('hex');
  }
}
