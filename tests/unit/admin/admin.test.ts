import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../../src/common/constants/rbac.ts';
import { ADMIN_ROUTES } from '../../../src/modules/admin/admin.routes.ts';
import {
  feeRuleBody,
  reasonBody,
  tierLimitBody,
  tierLimitParams,
  usersQuery,
} from '../../../src/modules/admin/admin.schema.ts';

describe('ADMIN_ROUTES', () => {
  it('declares each route once, each with a real permission', () => {
    const keys = ADMIN_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of ADMIN_ROUTES) expect(Object.keys(PERMISSIONS)).toContain(route.permission);
  });

  it('guards every change with a write permission, never a read one', () => {
    for (const route of ADMIN_ROUTES.filter((r) => r.method !== 'get')) {
      expect(route.permission, `${route.method} ${route.path}`).not.toMatch(/:read$/);
    }
  });
});

describe('admin schemas', () => {
  it('needs a 1–500 character reason', () => {
    expect(reasonBody.parse({ reason: ' AML hold ' })).toEqual({ reason: 'AML hold' });
    expect(reasonBody.safeParse({ reason: '   ' }).success).toBe(false);
    expect(reasonBody.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('pages users 50 at a time by default', () => {
    expect(usersQuery.parse({})).toEqual({ limit: 50 });
    expect(usersQuery.safeParse({ status: 'BANNED' }).success).toBe(false);
  });

  it('tier limits: positive kobo strings, per-transaction within daily, max balance or null', () => {
    const ok = { perTransactionLimit: '5000000', dailyOutflowLimit: '5000000', maxBalance: null };
    expect(tierLimitBody.parse(ok)).toEqual({
      perTransactionLimit: 5_000_000n,
      dailyOutflowLimit: 5_000_000n,
      maxBalance: null,
    });
    expect(tierLimitBody.safeParse({ ...ok, perTransactionLimit: '5000001' }).success).toBe(false);
    expect(tierLimitBody.safeParse({ ...ok, dailyOutflowLimit: '0' }).success).toBe(false);
    expect(tierLimitParams.safeParse({ tier: '4', currency: 'NGN' }).success).toBe(false);
    expect(tierLimitParams.parse({ tier: '2', currency: 'NGN' })).toEqual({
      tier: 2,
      currency: 'NGN',
    });
  });

  it('fee rules: zero allowed, bps 0–10000, min within max', () => {
    expect(feeRuleBody.parse({ flatFee: '0', percentageBps: 0 })).toEqual({
      flatFee: 0n,
      percentageBps: 0,
      minFee: null,
      maxFee: null,
    });
    expect(feeRuleBody.safeParse({ flatFee: '0', percentageBps: 10_001 }).success).toBe(false);
    expect(
      feeRuleBody.safeParse({ flatFee: '0', percentageBps: 10, minFee: '500', maxFee: '100' })
        .success,
    ).toBe(false);
    expect(feeRuleBody.safeParse({ flatFee: '-1', percentageBps: 0 }).success).toBe(false);
  });
});
