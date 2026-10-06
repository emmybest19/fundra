// Currencies Fundra operates in. NGN only for now; adding one here extends seeding of
// system ledger accounts, tier limits and fee rules.
export const CURRENCIES = ['NGN'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The currency a new user's first wallet is in (D3: created with Tier 1). */
export const DEFAULT_CURRENCY: Currency = 'NGN';

/** Minor units per major unit (kobo per naira). */
export const MINOR_UNITS: Readonly<Record<Currency, bigint>> = {
  NGN: 100n,
};

/** Converts whole major units to minor units, e.g. toMinor(50_000, 'NGN') === 5_000_000n. */
export function toMinor(major: number | bigint, currency: Currency): bigint {
  return BigInt(major) * MINOR_UNITS[currency];
}

const SYMBOLS: Readonly<Record<Currency, string>> = { NGN: '₦' };

/**
 * For messages shown to people, never for storage or arithmetic: 5_000_000n → `₦50,000.00`.
 * Pure bigint maths, so no float ever touches the amount.
 */
export function formatMinor(amount: bigint, currency: Currency): string {
  const unit = MINOR_UNITS[currency];
  const sign = amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  const whole = (abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % unit).toString().padStart(unit.toString().length - 1, '0');
  return `${sign}${SYMBOLS[currency]}${whole}.${fraction}`;
}

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}
