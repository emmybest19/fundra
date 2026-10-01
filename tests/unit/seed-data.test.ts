import { describe, expect, it } from 'vitest';
import {
  FEE_RULES,
  PAYMENT_PROVIDERS,
  systemLedgerAccounts,
  TIER_LIMITS,
} from '../../prisma/seed.ts';
import { toMinor } from '../../src/common/constants/currency.ts';

// The seed's data must satisfy the database's CHECK constraints (docs/DATABASE.md),
// otherwise `npm run db:seed` would fail. These tests catch a bad edit before it ships.

describe('toMinor', () => {
  it('converts naira to kobo exactly', () => {
    expect(toMinor(50_000, 'NGN')).toBe(5_000_000n);
    expect(toMinor(0, 'NGN')).toBe(0n);
  });
});

describe('TIER_LIMITS', () => {
  it('matches decision D3 for NGN, in kobo', () => {
    expect(TIER_LIMITS).toEqual([
      {
        tier: 1,
        currency: 'NGN',
        perTransactionLimit: 5_000_000n,
        dailyOutflowLimit: 5_000_000n,
        maxBalance: 30_000_000n,
      },
      {
        tier: 2,
        currency: 'NGN',
        perTransactionLimit: 10_000_000n,
        dailyOutflowLimit: 20_000_000n,
        maxBalance: 50_000_000n,
      },
      {
        tier: 3,
        currency: 'NGN',
        perTransactionLimit: 500_000_000n,
        dailyOutflowLimit: 500_000_000n,
        maxBalance: null,
      },
    ]);
  });

  it('satisfies the tier_limits CHECK constraints', () => {
    for (const limit of TIER_LIMITS) {
      expect(limit.tier).toBeGreaterThanOrEqual(1);
      expect(limit.tier).toBeLessThanOrEqual(3);
      expect(limit.perTransactionLimit).toBeGreaterThan(0n);
      expect(limit.perTransactionLimit).toBeLessThanOrEqual(limit.dailyOutflowLimit);
      if (limit.maxBalance !== null) expect(limit.maxBalance).toBeGreaterThan(0n);
    }
  });

  it('never lowers a limit as the tier rises', () => {
    for (let i = 1; i < TIER_LIMITS.length; i++) {
      const lower = TIER_LIMITS[i - 1];
      const higher = TIER_LIMITS[i];
      if (lower === undefined || higher === undefined) throw new Error('unreachable');
      expect(higher.perTransactionLimit).toBeGreaterThanOrEqual(lower.perTransactionLimit);
      expect(higher.dailyOutflowLimit).toBeGreaterThanOrEqual(lower.dailyOutflowLimit);
    }
  });
});

describe('FEE_RULES', () => {
  it('starts P2P transfers at zero fee (D6) within the bps CHECK', () => {
    expect(FEE_RULES).toEqual([
      { transactionType: 'TRANSFER', currency: 'NGN', flatFee: 0n, percentageBps: 0 },
    ]);
  });
});

describe('systemLedgerAccounts', () => {
  it('creates settlement, fee revenue and suspense accounts per currency', () => {
    expect(systemLedgerAccounts()).toEqual([
      { code: 'PROVIDER_SETTLEMENT:MOCK:NGN', type: 'ASSET', currency: 'NGN' },
      { code: 'FEE_REVENUE:NGN', type: 'REVENUE', currency: 'NGN' },
      { code: 'SUSPENSE:NGN', type: 'LIABILITY', currency: 'NGN' },
    ]);
  });

  it('has one settlement account per payment provider', () => {
    const settlement = systemLedgerAccounts().filter((a) => a.code.startsWith('PROVIDER_'));
    expect(settlement).toHaveLength(PAYMENT_PROVIDERS.length);
  });
});
