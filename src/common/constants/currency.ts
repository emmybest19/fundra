// Currencies Fundra operates in. NGN only for now; adding one here extends seeding of
// system ledger accounts, tier limits and fee rules.
export const CURRENCIES = ['NGN'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Minor units per major unit (kobo per naira). */
export const MINOR_UNITS: Readonly<Record<Currency, bigint>> = {
  NGN: 100n,
};

/** Converts whole major units to minor units, e.g. toMinor(50_000, 'NGN') === 5_000_000n. */
export function toMinor(major: number | bigint, currency: Currency): bigint {
  return BigInt(major) * MINOR_UNITS[currency];
}
