// HTTP side of idempotency: reading the Idempotency-Key header and fingerprinting the request.
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { BadRequestError, ErrorCode } from '../errors/index.ts';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/** 8–255 visible ASCII characters (matches the database CHECK). UUIDs are the norm. */
const VALID_KEY = /^[\x21-\x7E]{8,255}$/;

export function idempotencyKeyFrom(req: Request): string {
  const key = req.get(IDEMPOTENCY_KEY_HEADER);
  if (key === undefined || key === '') {
    throw new BadRequestError(
      `The ${IDEMPOTENCY_KEY_HEADER} header is required for this request.`,
      {
        code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      },
    );
  }
  if (!VALID_KEY.test(key)) {
    throw new BadRequestError(
      `The ${IDEMPOTENCY_KEY_HEADER} header must be 8–255 visible ASCII characters (a UUID is recommended).`,
      { code: ErrorCode.IDEMPOTENCY_KEY_INVALID },
    );
  }
  return key;
}

/** JSON with object keys sorted at every level, so key order never changes the fingerprint. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  // Typed as string, but returns undefined for undefined (e.g. a request without a body).
  const json = JSON.stringify(value) as string | undefined;
  return json ?? 'null';
}

/**
 * SHA-256 of method, path and canonical body. Reusing a key for a different request (other
 * amount, other recipient, other endpoint) is detected by comparing fingerprints.
 * Uses the raw parsed JSON body, before any validation transforms.
 */
export function requestFingerprint(req: Request): string {
  const path = `${req.baseUrl}${req.path}`;
  return createHash('sha256')
    .update(`${req.method} ${path}\n${canonicalJson(req.body)}`)
    .digest('hex');
}
