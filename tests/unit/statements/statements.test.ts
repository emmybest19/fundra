import { describe, expect, it } from 'vitest';
import {
  csvCell,
  decimal,
  lagosTimestamp,
  statementCsv,
} from '../../../src/modules/statements/statement.csv.ts';
import { requestStatementBody } from '../../../src/modules/statements/statement.schema.ts';
import { periodBounds } from '../../../src/modules/statements/statement.service.ts';

const WALLET = '01a1407d-89c4-7fff-9ad3-9b767ad1c8c6';

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises formulas (CSV injection): = + - @ tab and CR start as text', () => {
    for (const evil of [
      '=HYPERLINK("http://x","click")',
      '+1+1',
      '-2+3',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ]) {
      expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
  });
});

describe('money and time', () => {
  it('kobo → naira with two decimals, exact for large amounts', () => {
    expect(decimal(150_025n, 'NGN')).toBe('1500.25');
    expect(decimal(5n, 'NGN')).toBe('0.05');
    expect(decimal(0n, 'NGN')).toBe('0.00');
    expect(decimal(900_719_925_474_099_312n, 'NGN')).toBe('9007199254740993.12');
  });

  it('timestamps in Lagos wall-clock time (UTC+1)', () => {
    expect(lagosTimestamp(new Date('2026-10-15T23:30:00.000Z'))).toBe('2026-10-16 00:30:00');
  });

  it('periodBounds covers the Lagos days inclusively', () => {
    expect(periodBounds('2026-10-01', '2026-10-31')).toEqual({
      start: new Date('2026-09-30T23:00:00.000Z'),
      end: new Date('2026-10-31T23:00:00.000Z'),
    });
  });
});

describe('statementCsv', () => {
  it('has a header block, then one row per entry with debit or credit and the running balance', () => {
    const csv = statementCsv({
      accountName: 'Ada Okafor',
      accountNumber: '0123456789',
      currency: 'NGN',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      openingBalance: 100_000n,
      closingBalance: 50_000n,
      lines: [
        {
          at: new Date('2026-10-02T09:00:00Z'),
          reference: 'FND-TRX-1',
          type: 'TRANSFER',
          description: '=cmd|calc',
          direction: 'DEBIT',
          amount: 50_000n,
          balanceAfter: 50_000n,
        },
      ],
    });
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('Account name,Ada Okafor');
    expect(lines[5]).toBe('Opening balance,1000.00');
    expect(lines[8]).toBe('Date,Reference,Type,Description,Debit,Credit,Balance');
    expect(lines[9]).toBe("2026-10-02 10:00:00,FND-TRX-1,TRANSFER,'=cmd|calc,500.00,,500.00");
  });
});

describe('requestStatementBody', () => {
  it('takes a wallet and inclusive dates', () => {
    expect(
      requestStatementBody.parse({ walletId: WALLET, from: '2026-01-01', to: '2026-01-31' }),
    ).toEqual({ walletId: WALLET, from: '2026-01-01', to: '2026-01-31' });
  });

  it.each([
    ['from after to', { from: '2026-02-01', to: '2026-01-31' }],
    ['a future end', { from: '2026-01-01', to: '2999-01-01' }],
    ['over 366 days', { from: '2024-01-01', to: '2025-01-02' }],
    ['not a date', { from: '01/01/2026', to: '2026-01-31' }],
  ])('refuses %s', (_label, dates) => {
    expect(requestStatementBody.safeParse({ walletId: WALLET, ...dates }).success).toBe(false);
  });

  it('allows exactly 366 days', () => {
    expect(
      requestStatementBody.safeParse({ walletId: WALLET, from: '2024-01-01', to: '2024-12-31' })
        .success,
    ).toBe(true);
  });
});
