import { describe, expect, it } from 'vitest';
import {
  assertValidEntries,
  balanceChange,
  PostingInvariantError,
  walletStatusRefusal,
} from '../../../src/modules/ledger/ledger.utils.ts';
import type { PostingEntry } from '../../../src/modules/ledger/ledger.types.ts';

const debit = (ledgerAccountId: string, amount: bigint): PostingEntry => ({
  ledgerAccountId,
  direction: 'DEBIT',
  amount,
});
const credit = (ledgerAccountId: string, amount: bigint): PostingEntry => ({
  ledgerAccountId,
  direction: 'CREDIT',
  amount,
});

describe('assertValidEntries', () => {
  it('accepts a balanced posting, including a fee split', () => {
    expect(() => {
      assertValidEntries([debit('a', 1_000_000n), credit('b', 1_000_000n)]);
    }).not.toThrow();
    expect(() => {
      assertValidEntries([debit('a', 1_005_000n), credit('b', 1_000_000n), credit('fee', 5_000n)]);
    }).not.toThrow();
  });

  it('refuses an unbalanced posting, by one kobo', () => {
    expect(() => {
      assertValidEntries([debit('a', 1_000_000n), credit('b', 999_999n)]);
    }).toThrow(/unbalanced: debits 1000000 ≠ credits 999999/);
  });

  it('refuses fewer than two entries', () => {
    expect(() => {
      assertValidEntries([debit('a', 1n)]);
    }).toThrow(/at least two/);
    expect(() => {
      assertValidEntries([]);
    }).toThrow(/at least two/);
  });

  it('refuses zero, negative and non-bigint amounts', () => {
    expect(() => {
      assertValidEntries([debit('a', 0n), credit('b', 0n)]);
    }).toThrow(/positive/);
    expect(() => {
      assertValidEntries([debit('a', -5n), credit('b', -5n)]);
    }).toThrow(/positive/);
    expect(() => {
      assertValidEntries([
        { ledgerAccountId: 'a', direction: 'DEBIT', amount: 5 as unknown as bigint },
        credit('b', 5n),
      ]);
    }).toThrow(/positive/);
  });

  it('refuses the same account twice (a wallet paying itself)', () => {
    expect(() => {
      assertValidEntries([debit('a', 10n), credit('a', 10n)]);
    }).toThrow(/appears twice/);
  });

  it('throws PostingInvariantError: a bug, never a user-facing message', () => {
    expect(() => {
      assertValidEntries([]);
    }).toThrow(PostingInvariantError);
  });
});

describe('balanceChange', () => {
  it('liabilities (wallets) and revenue grow with credits', () => {
    expect(balanceChange('LIABILITY', 'CREDIT', 100n)).toBe(100n);
    expect(balanceChange('LIABILITY', 'DEBIT', 100n)).toBe(-100n);
    expect(balanceChange('REVENUE', 'CREDIT', 5n)).toBe(5n);
  });

  it('assets and expenses grow with debits', () => {
    expect(balanceChange('ASSET', 'DEBIT', 100n)).toBe(100n);
    expect(balanceChange('ASSET', 'CREDIT', 100n)).toBe(-100n);
    expect(balanceChange('EXPENSE', 'DEBIT', 7n)).toBe(7n);
  });
});

describe('walletStatusRefusal', () => {
  it('lets an ACTIVE wallet take part in anything', () => {
    for (const type of ['TRANSFER', 'DEPOSIT', 'REVERSAL'] as const) {
      expect(walletStatusRefusal('ACTIVE', type)).toBeNull();
    }
  });

  it('refuses a CLOSED wallet always, even for a reversal', () => {
    for (const type of ['TRANSFER', 'DEPOSIT', 'REVERSAL', 'REFUND'] as const) {
      expect(walletStatusRefusal('CLOSED', type)).toBe('WALLET_CLOSED');
    }
  });

  it('refuses a FROZEN wallet except for reversals and refunds', () => {
    for (const type of ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'PAYMENT', 'FEE'] as const) {
      expect(walletStatusRefusal('FROZEN', type), type).toBe('WALLET_FROZEN');
    }
    expect(walletStatusRefusal('FROZEN', 'REVERSAL')).toBeNull();
    expect(walletStatusRefusal('FROZEN', 'REFUND')).toBeNull();
  });
});
