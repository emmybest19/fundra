// Wallet account numbers (D2): 9 random digits + a Damm check digit. Random, not sequential,
// so one number says nothing about the next. The check digit catches every single-digit typo
// and every swap of two neighbouring digits, so a mistyped number is refused before any
// lookup instead of reaching a stranger.
import { randomInt } from 'node:crypto';

/** Damm's quasigroup of order 10 (weakly totally anti-symmetric). */
const DAMM: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

/** The Damm digit for a string of digits: appending it makes the whole string check to 0. */
export function dammCheckDigit(digits: string): number {
  let interim = 0;
  for (const char of digits) {
    interim = DAMM[interim]?.[Number(char)] ?? Number.NaN;
  }
  if (Number.isNaN(interim)) throw new Error('dammCheckDigit expects digits only');
  return interim;
}

/** 10 digits whose Damm check comes out at 0. */
export function isValidAccountNumber(value: string): boolean {
  return /^\d{10}$/.test(value) && dammCheckDigit(value) === 0;
}

export function generateAccountNumber(): string {
  const body = String(randomInt(0, 1_000_000_000)).padStart(9, '0');
  return `${body}${String(dammCheckDigit(body))}`;
}
