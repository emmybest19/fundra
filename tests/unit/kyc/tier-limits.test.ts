import { describe, expect, it, vi } from 'vitest';
import {
  checkInflow,
  checkOutflow,
  findTierLimits,
  inflowLimitError,
  outflowLimitError,
  tierLimitsView,
  type TierLimits,
} from '../../../src/modules/kyc/tier-limits.ts';

// D3 Tier 1, in kobo.
const TIER1: TierLimits = {
  perTransaction: 5_000_000n,
  dailyOutflow: 5_000_000n,
  maxBalance: 30_000_000n,
};
const TIER2: TierLimits = {
  perTransaction: 10_000_000n,
  dailyOutflow: 20_000_000n,
  maxBalance: 50_000_000n,
};

function dbWith(rows: Record<string, TierLimits | undefined>) {
  const findUnique = vi.fn(
    ({ where }: { where: { tier_currency: { tier: number; currency: string } } }) => {
      const { tier, currency } = where.tier_currency;
      const limits = rows[`${String(tier)}:${currency}`];
      return Promise.resolve(
        limits === undefined
          ? null
          : {
              tier,
              currency,
              perTransactionLimit: limits.perTransaction,
              dailyOutflowLimit: limits.dailyOutflow,
              maxBalance: limits.maxBalance,
              updatedAt: new Date(),
            },
      );
    },
  );
  return { db: { tierLimit: { findUnique } } as never, findUnique };
}

describe('checkOutflow', () => {
  it('allows exactly the per-transaction limit and refuses one kobo more', () => {
    expect(
      checkOutflow({ limits: TIER1, amount: 5_000_000n, fee: 0n, outflowToday: 0n }),
    ).toBeNull();
    expect(checkOutflow({ limits: TIER1, amount: 5_000_001n, fee: 0n, outflowToday: 0n })).toEqual({
      rule: 'PER_TRANSACTION',
      limit: 5_000_000n,
    });
  });

  it('counts the fee: amount + fee is what leaves the wallet', () => {
    expect(
      checkOutflow({ limits: TIER1, amount: 4_999_950n, fee: 50n, outflowToday: 0n }),
    ).toBeNull();
    expect(
      checkOutflow({ limits: TIER1, amount: 4_999_950n, fee: 51n, outflowToday: 0n })?.rule,
    ).toBe('PER_TRANSACTION');
  });

  it('allows reaching the daily limit exactly, and says what is left when over', () => {
    expect(
      checkOutflow({ limits: TIER2, amount: 5_000_000n, fee: 0n, outflowToday: 15_000_000n }),
    ).toBeNull();
    expect(
      checkOutflow({ limits: TIER2, amount: 5_000_000n, fee: 1n, outflowToday: 15_000_000n }),
    ).toEqual({ rule: 'DAILY_OUTFLOW', limit: 20_000_000n, remaining: 5_000_000n });
  });

  it('never reports a negative remainder (limit lowered after spending)', () => {
    expect(
      checkOutflow({ limits: TIER1, amount: 100n, fee: 0n, outflowToday: 9_000_000n }),
    ).toEqual({ rule: 'DAILY_OUTFLOW', limit: 5_000_000n, remaining: 0n });
  });
});

describe('checkInflow', () => {
  it('allows reaching the max balance exactly and refuses one kobo more', () => {
    expect(checkInflow({ limits: TIER1, kind: 'DEPOSIT', balanceAfter: 30_000_000n })).toBeNull();
    expect(checkInflow({ limits: TIER1, kind: 'TRANSFER_IN', balanceAfter: 30_000_001n })).toEqual({
      rule: 'MAX_BALANCE',
      limit: 30_000_000n,
    });
  });

  it('never blocks refunds or reversals: they return the user’s own money', () => {
    expect(checkInflow({ limits: TIER1, kind: 'REFUND', balanceAfter: 99_000_000n })).toBeNull();
    expect(checkInflow({ limits: TIER1, kind: 'REVERSAL', balanceAfter: 99_000_000n })).toBeNull();
  });

  it('treats a NULL max balance as unlimited', () => {
    expect(
      checkInflow({
        limits: { ...TIER1, maxBalance: null },
        kind: 'DEPOSIT',
        balanceAfter: 10n ** 15n,
      }),
    ).toBeNull();
  });
});

describe('limit errors', () => {
  it('tells the sender their own limit and what is left today', () => {
    const perTx = outflowLimitError({ rule: 'PER_TRANSACTION', limit: 5_000_000n }, 'NGN');
    const daily = outflowLimitError(
      { rule: 'DAILY_OUTFLOW', limit: 20_000_000n, remaining: 1_250_050n },
      'NGN',
    );

    expect([perTx.statusCode, perTx.code]).toEqual([422, 'LIMIT_PER_TRANSACTION_EXCEEDED']);
    expect(perTx.message).toContain('₦50,000.00');
    expect(daily.code).toBe('LIMIT_DAILY_OUTFLOW_EXCEEDED');
    expect(daily.message).toContain('₦200,000.00');
    expect(daily.message).toContain('₦12,500.50 more today');
  });

  it('tells a depositor their own max balance', () => {
    const error = inflowLimitError({ rule: 'MAX_BALANCE', limit: 30_000_000n }, 'NGN', 'SELF');

    expect(error.code).toBe('LIMIT_MAX_BALANCE_EXCEEDED');
    expect(error.message).toContain('₦300,000.00');
  });

  it('tells a sender nothing about the recipient: no tier, limit or amount', () => {
    const error = inflowLimitError({ rule: 'MAX_BALANCE', limit: 30_000_000n }, 'NGN', 'OTHER');

    expect(error.code).toBe('RECIPIENT_CANNOT_RECEIVE');
    expect(error.message).not.toMatch(/\d|tier|limit|balance/i);
  });
});

describe('findTierLimits', () => {
  it('reads the row for the tier and currency', async () => {
    const { db, findUnique } = dbWith({ '1:NGN': TIER1 });

    expect(await findTierLimits(db, 1, 'NGN')).toEqual(TIER1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { tier_currency: { tier: 1, currency: 'NGN' } },
    });
  });

  it('has no limits at tier 0 (no money movement at all), without asking the database', async () => {
    const { db, findUnique } = dbWith({});

    expect(await findTierLimits(db, 0, 'NGN')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when a verified tier has no row: missing never means unlimited', async () => {
    await expect(findTierLimits(dbWith({}).db, 2, 'NGN')).rejects.toThrow(
      'No tier limits configured for tier 2 NGN',
    );
  });
});

describe('tierLimitsView', () => {
  it('shows kobo strings per currency, with null for an unlimited balance', async () => {
    const { db } = dbWith({
      '3:NGN': { perTransaction: 500_000_000n, dailyOutflow: 500_000_000n, maxBalance: null },
    });

    expect(await tierLimitsView(db, 3)).toEqual({
      NGN: { perTransaction: '500000000', dailyOutflow: '500000000', maxBalance: null },
    });
  });

  it('is null below Tier 1 and above Tier 3', async () => {
    const { db, findUnique } = dbWith({});

    expect(await tierLimitsView(db, 0)).toBeNull();
    expect(await tierLimitsView(db, 4)).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
