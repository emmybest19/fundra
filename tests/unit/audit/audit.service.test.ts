import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { isSensitiveKey } from '../../../src/common/constants/sensitive-keys.ts';
import { requestId } from '../../../src/middleware/request-id.middleware.ts';
import {
  auditContextFrom,
  MAX_METADATA_BYTES,
  MAX_USER_AGENT_LENGTH,
  recordAudit,
  sanitizeMetadata,
  toAuditRow,
  type AuditWriter,
} from '../../../src/modules/audit/audit.service.ts';
import { AUDIT_ACTIONS, type AuditEntry } from '../../../src/modules/audit/audit.types.ts';

describe('AUDIT_ACTIONS', () => {
  it('uses domain.event names', () => {
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('has no duplicates', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('rejects invalid entries at compile time', () => {
    const entries: AuditEntry[] = [
      // @ts-expect-error -- unknown action names don't compile
      { action: 'kyc.aproved', actor: { type: 'SYSTEM' } },
      // @ts-expect-error -- users and admins must be identified
      { action: 'kyc.approved', actor: { type: 'ADMIN' } },
      // @ts-expect-error -- the system never has a user ID
      { action: 'wallet.created', actor: { type: 'SYSTEM', userId: 'u1' } },
    ];
    expect(entries).toHaveLength(3);
  });
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'PASSWORD',
    'refresh_token',
    'Refresh-Token',
    'accessToken',
    'BVN',
    'otp',
    'Authorization',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['amount', 'handle', 'walletId', 'reason', 'tokenCount'])('allows %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('sanitizeMetadata', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(
      sanitizeMetadata({
        reason: 'support request',
        password: 'hunter2',
        request: { body: { refresh_token: 'rt_1', handle: 'emma' } },
        attempts: [{ otp: '123456' }],
      }),
    ).toEqual({
      reason: 'support request',
      password: '[REDACTED]',
      request: { body: { refresh_token: '[REDACTED]', handle: 'emma' } },
      attempts: [{ otp: '[REDACTED]' }],
    });
  });

  it('stores bigint amounts as exact strings and dates as ISO strings', () => {
    expect(
      sanitizeMetadata({
        amount: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
        at: new Date('2026-10-02T09:00:00.000Z'),
      }),
    ).toEqual({ amount: '9007199254740993', at: '2026-10-02T09:00:00.000Z' });
  });

  it('keeps values JSON-safe', () => {
    expect(
      sanitizeMetadata({ nan: Number.NaN, inf: Infinity, nothing: undefined, fn: () => 1 }),
    ).toEqual({ nan: 'NaN', inf: 'Infinity', nothing: null, fn: '[function]' });
  });

  it('caps circular references and deep nesting instead of throwing', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };

    expect(sanitizeMetadata({ loop })).toEqual({ loop: { name: 'loop', self: '[CIRCULAR]' } });
    expect(JSON.stringify(sanitizeMetadata(deep))).toContain('[MAX_DEPTH]');
  });

  it('replaces oversized metadata with a marker', () => {
    const result = sanitizeMetadata({ blob: 'x'.repeat(MAX_METADATA_BYTES) });

    expect(result).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100);
  });

  it('defaults to an empty object', () => {
    expect(sanitizeMetadata()).toEqual({});
  });
});

describe('toAuditRow', () => {
  it('maps a user action with resource, context and metadata', () => {
    expect(
      toAuditRow({
        action: 'beneficiary.created',
        actor: { type: 'USER', userId: 'user-1' },
        resource: { type: 'beneficiary', id: 'ben-1' },
        context: { ip: '203.0.113.7', userAgent: 'curl/8', requestId: 'req-1' },
        metadata: { nickname: 'Mum' },
      }),
    ).toEqual({
      action: 'beneficiary.created',
      actorType: 'USER',
      actorUserId: 'user-1',
      resourceType: 'beneficiary',
      resourceId: 'ben-1',
      ipAddress: '203.0.113.7',
      userAgent: 'curl/8',
      requestId: 'req-1',
      metadata: { nickname: 'Mum' },
    });
  });

  it('stores system actions without a user, resource or context', () => {
    expect(toAuditRow({ action: 'wallet.created', actor: { type: 'SYSTEM' } })).toEqual({
      action: 'wallet.created',
      actorType: 'SYSTEM',
      actorUserId: null,
      resourceType: null,
      resourceId: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
      metadata: {},
    });
  });
});

describe('recordAudit', () => {
  it('writes through the given client, so it joins the caller’s transaction', async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = { auditLog: { create } } as unknown as AuditWriter;

    await recordAudit(tx, { action: 'kyc.approved', actor: { type: 'ADMIN', userId: 'admin-1' } });

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'kyc.approved', actorUserId: 'admin-1' }) as unknown,
    });
  });

  it('propagates write failures, so an action is never committed without its audit row', async () => {
    const tx = {
      auditLog: { create: vi.fn().mockRejectedValue(new Error('connection lost')) },
    } as unknown as AuditWriter;

    await expect(
      recordAudit(tx, { action: 'transaction.reversed', actor: { type: 'SYSTEM' } }),
    ).rejects.toThrow('connection lost');
  });
});

describe('auditContextFrom', () => {
  it('takes IP, capped user agent and request ID from the request', async () => {
    let context: unknown;
    const app = express();
    app.use(requestId);
    app.get('/', (req, res) => {
      context = auditContextFrom(req);
      res.end();
    });

    await request(app).get('/').set('User-Agent', 'u'.repeat(2_000)).set('X-Request-Id', 'req-42');

    expect(context).toMatchObject({ requestId: 'req-42', ip: expect.any(String) as unknown });
    expect((context as { userAgent: string }).userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
  });
});
