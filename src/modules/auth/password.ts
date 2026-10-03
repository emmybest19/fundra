// Password hashing (Argon2id) and the password policy.
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';

/**
 * OWASP's recommended Argon2id configuration (m=19 MiB, t=2, p=1): ~50 ms per hash on the
 * development machine. Hashes record their own parameters, so these can be raised later;
 * older hashes are upgraded transparently at the next successful login (needsRehash).
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
/** Caps hashing cost: a 1 MB "password" must not be able to tie up the CPU. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * NIST SP 800-63B style: length over composition rules (no "must contain a symbol").
 * Personal-data checks (handle, email) need the other fields: see passwordIsNotPersonal.
 */
export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${String(PASSWORD_MIN_LENGTH)} characters`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${String(PASSWORD_MAX_LENGTH)} characters`)
  // Only for passwords that pass the length check; otherwise a short password would get two
  // errors, the second ("mostly spaces") misleading.
  .refine(
    (value) => value.length < PASSWORD_MIN_LENGTH || value.trim().length >= PASSWORD_MIN_LENGTH,
    'Must not be mostly spaces',
  );

/** True if the password doesn't contain the user's handle or the name part of their email. */
export function passwordIsNotPersonal(
  value: string,
  personal: { handle: string; email: string },
): boolean {
  const lower = value.toLowerCase();
  const emailName = personal.email.split('@')[0] ?? '';
  return [personal.handle, emailName]
    .filter((part) => part.length >= 3)
    .every((part) => !lower.includes(part.toLowerCase()));
}

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/** Never throws on a wrong password; returns false. Malformed hashes are treated as no match. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, ARGON2_OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Used when the account doesn't exist, so
 * response timing can't reveal which emails and phones are registered.
 */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(await dummyHash, plain);
  return false;
}
