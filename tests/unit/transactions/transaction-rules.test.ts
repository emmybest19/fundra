import { describe, expect, it } from 'vitest';
import {
  canTransactionTransition,
  generateReference,
  REFERENCE_PATTERN,
  TRANSACTION_SHAPES,
  TRANSACTION_TRANSITIONS,
} from '../../../src/modules/transactions/transaction.types.ts';

describe('transaction status lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    expect(TRANSACTION_TRANSITIONS).toEqual({
      PENDING: ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
      PROCESSING: ['COMPLETED', 'FAILED'],
      COMPLETED: ['REVERSED'],
      FAILED: [],
      CANCELLED: [],
      REVERSED: [],
    });
  });

  it('never leaves a final status, and never cancels work already with a provider', () => {
    for (const final of ['FAILED', 'CANCELLED', 'REVERSED'] as const) {
      for (const to of ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const) {
        expect(canTransactionTransition(final, to), `${final} → ${to}`).toBe(false);
      }
    }
    expect(canTransactionTransition('PROCESSING', 'CANCELLED')).toBe(false);
    expect(canTransactionTransition('COMPLETED', 'FAILED')).toBe(false);
  });
});

describe('generateReference', () => {
  it('matches the database CHECK (FND-TRX-YYYYMMDD-XXXXXX, upper-case hex)', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateReference(Date.now())).toMatch(REFERENCE_PATTERN);
    }
  });

  it('dates by the Lagos business day: 23:30 UTC is already tomorrow', () => {
    expect(generateReference(Date.parse('2026-10-14T22:59:00Z'))).toMatch(/^FND-TRX-20261014-/);
    expect(generateReference(Date.parse('2026-10-14T23:30:00Z'))).toMatch(/^FND-TRX-20261015-/);
  });

  it('is random: no repeats across many references', () => {
    const refs = new Set(Array.from({ length: 2_000 }, () => generateReference(Date.now())));
    expect(refs.size).toBeGreaterThan(1_995);
  });
});

describe('TRANSACTION_SHAPES', () => {
  it('money in has only a destination, money out only a source, transfers both', () => {
    expect(TRANSACTION_SHAPES.DEPOSIT).toEqual({ source: 'forbidden', destination: 'required' });
    expect(TRANSACTION_SHAPES.REFUND).toEqual({ source: 'forbidden', destination: 'required' });
    for (const type of ['WITHDRAWAL', 'PAYMENT', 'FEE'] as const) {
      expect(TRANSACTION_SHAPES[type], type).toEqual({
        source: 'required',
        destination: 'forbidden',
      });
    }
    expect(TRANSACTION_SHAPES.TRANSFER).toEqual({ source: 'required', destination: 'required' });
  });
});
