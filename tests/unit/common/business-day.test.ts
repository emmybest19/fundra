import { describe, expect, it } from 'vitest';
import { formatMinor } from '../../../src/common/constants/currency.ts';
import { lagosDate, lagosDayBounds } from '../../../src/common/utils/business-day.ts';

describe('lagosDate', () => {
  it('turns over at 23:00 UTC, Lagos midnight', () => {
    expect(lagosDate(Date.parse('2026-10-05T22:59:59.999Z'))).toBe('2026-10-05');
    expect(lagosDate(Date.parse('2026-10-05T23:00:00.000Z'))).toBe('2026-10-06');
  });
});

describe('lagosDayBounds', () => {
  it('spans Lagos midnight to Lagos midnight, as UTC instants', () => {
    const { start, end } = lagosDayBounds(Date.parse('2026-10-06T10:00:00Z'));

    expect(start.toISOString()).toBe('2026-10-05T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-06T23:00:00.000Z');
  });

  it('puts 23:30 UTC in the next Lagos day, and 22:30 UTC in the current one', () => {
    expect(lagosDayBounds(Date.parse('2026-10-05T23:30:00Z')).start.toISOString()).toBe(
      '2026-10-05T23:00:00.000Z',
    );
    expect(lagosDayBounds(Date.parse('2026-10-05T22:30:00Z')).start.toISOString()).toBe(
      '2026-10-04T23:00:00.000Z',
    );
  });

  it('is half-open: the end instant belongs to the next day', () => {
    const today = lagosDayBounds(Date.parse('2026-10-06T10:00:00Z'));
    const tomorrow = lagosDayBounds(today.end.getTime());

    expect(tomorrow.start.getTime()).toBe(today.end.getTime());
  });
});

describe('formatMinor', () => {
  it.each([
    [0n, '₦0.00'],
    [5n, '₦0.05'],
    [5_000_000n, '₦50,000.00'],
    [1_250_050n, '₦12,500.50'],
    [123_456_789_012n, '₦1,234,567,890.12'],
    [-150n, '-₦1.50'],
  ])('%s kobo → %s', (amount, text) => {
    expect(formatMinor(amount, 'NGN')).toBe(text);
  });
});
