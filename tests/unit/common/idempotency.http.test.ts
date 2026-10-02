import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { normalizeError } from '../../../src/common/errors/index.ts';
import {
  canonicalJson,
  idempotencyKeyFrom,
  requestFingerprint,
} from '../../../src/common/idempotency/idempotency.http.ts';

/** Runs `fn` inside a real Express request and returns its result or error code. */
async function inRequest<T>(
  fn: (req: express.Request) => T,
  setup: (test: request.Test) => request.Test,
  path = '/api/v1/transfers',
): Promise<{ value?: T; code?: string }> {
  let outcome: { value?: T; code?: string } = {};
  const app = express();
  app.use(express.json());
  app.post('/api/v1/:resource', (req, res) => {
    try {
      outcome = { value: fn(req) };
    } catch (err) {
      outcome = { code: normalizeError(err).code };
    }
    res.end();
  });
  await setup(request(app).post(path));
  return outcome;
}

describe('idempotencyKeyFrom', () => {
  it('returns a valid key', async () => {
    const key = '3f6c2b1e-9a7d-4c1e-8f2a-5b6c7d8e9f00';
    expect(await inRequest(idempotencyKeyFrom, (t) => t.set('Idempotency-Key', key))).toEqual({
      value: key,
    });
  });

  it('requires the header', async () => {
    expect(await inRequest(idempotencyKeyFrom, (t) => t)).toEqual({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'k'.repeat(256)],
    ['contains a space', 'my key 12345'],
  ])('rejects a key that is %s', async (_case, key) => {
    expect(await inRequest(idempotencyKeyFrom, (t) => t.set('Idempotency-Key', key))).toEqual({
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('treats undefined fields as absent and a missing body as null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('requestFingerprint', () => {
  const body = { recipientHandle: 'tolu', amount: '1000000', currency: 'NGN' };
  const fingerprint = (sent: object, path?: string) =>
    inRequest(requestFingerprint, (t) => t.send(sent), path).then((r) => r.value);

  it('is a SHA-256 hex digest', async () => {
    expect(await fingerprint(body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order', async () => {
    const reordered = { currency: 'NGN', amount: '1000000', recipientHandle: 'tolu' };
    expect(await fingerprint(reordered)).toBe(await fingerprint(body));
  });

  it('changes when the amount, recipient or endpoint changes', async () => {
    const original = await fingerprint(body);

    expect(await fingerprint({ ...body, amount: '1000001' })).not.toBe(original);
    expect(await fingerprint({ ...body, recipientHandle: 'emma' })).not.toBe(original);
    expect(await fingerprint(body, '/api/v1/withdrawals')).not.toBe(original);
  });
});
