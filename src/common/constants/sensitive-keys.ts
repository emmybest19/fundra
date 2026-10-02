// Field names whose values must never reach logs or audit records.
// Shared by the logger (exact-case redaction paths) and the audit sanitizer (fuzzy match).

export const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'otp',
  'pin',
  'bvn',
  'nin',
  'authorization',
  'cookie',
] as const;

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const NORMALIZED = new Set<string>(SENSITIVE_KEYS.map(normalize));

/**
 * True for sensitive keys regardless of case or separators, so `refresh_token`,
 * `Refresh-Token` and `refreshToken` all match.
 */
export function isSensitiveKey(key: string): boolean {
  return NORMALIZED.has(normalize(key));
}
