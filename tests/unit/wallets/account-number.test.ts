import { describe, expect, it } from 'vitest';
import {
  dammCheckDigit,
  generateAccountNumber,
  isValidAccountNumber,
} from '../../../src/modules/wallets/account-number.ts';

describe('dammCheckDigit', () => {
  it('matches the published Damm example (572 → 4)', () => {
    expect(dammCheckDigit('572')).toBe(4);
    expect(dammCheckDigit('5724')).toBe(0);
  });

  it('refuses non-digits', () => {
    expect(() => dammCheckDigit('12a')).toThrow();
  });
});

describe('generateAccountNumber', () => {
  it('always makes 10 digits that pass the check', () => {
    for (let i = 0; i < 2_000; i++) {
      const number = generateAccountNumber();
      expect(number).toMatch(/^\d{10}$/);
      expect(isValidAccountNumber(number), number).toBe(true);
    }
  });

  it('is random, not sequential', () => {
    const numbers = new Set(Array.from({ length: 500 }, () => generateAccountNumber()));
    expect(numbers.size).toBe(500);
  });
});

describe('isValidAccountNumber', () => {
  const samples = Array.from({ length: 200 }, () => generateAccountNumber());

  it('catches every single-digit typo', () => {
    for (const number of samples) {
      for (let position = 0; position < 10; position++) {
        for (let digit = 0; digit <= 9; digit++) {
          if (String(digit) === number[position]) continue;
          const typo = `${number.slice(0, position)}${String(digit)}${number.slice(position + 1)}`;
          expect(isValidAccountNumber(typo), `${number} → ${typo}`).toBe(false);
        }
      }
    }
  });

  it('catches every swap of two neighbouring digits (including 09 ↔ 90, which Luhn misses)', () => {
    const withZeroNine = '09' + '1234567';
    const tricky = `${withZeroNine}${String(dammCheckDigit(withZeroNine))}`;
    for (const number of [...samples, tricky]) {
      for (let position = 0; position < 9; position++) {
        const [a, b] = [number[position], number[position + 1]];
        if (a === b) continue;
        const swapped = `${number.slice(0, position)}${b ?? ''}${a ?? ''}${number.slice(position + 2)}`;
        expect(isValidAccountNumber(swapped), `${number} → ${swapped}`).toBe(false);
      }
    }
  });

  it('refuses anything that is not exactly 10 digits', () => {
    const good = generateAccountNumber();
    for (const bad of [good.slice(0, 9), `${good}0`, ` ${good}`, good.replace(/\d$/, 'x'), '']) {
      expect(isValidAccountNumber(bad), bad).toBe(false);
    }
  });
});
