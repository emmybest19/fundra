// Reusable Zod building blocks for request schemas. Object schemas should use
// z.strictObject so unknown fields are rejected rather than silently dropped.
import { z } from 'zod';
import { CURRENCIES } from '../constants/currency.ts';

/**
 * D1: money in minor units (kobo) as a string, e.g. "1000000" = ₦10,000.00. Positive, no
 * sign, decimals, exponent or leading zeros; at most 15 digits (< ₦10 trillion), so it is far
 * inside PostgreSQL bigint. Parsed to `bigint`: services never see strings or floats.
 */
export const amount = z
  .string()
  .regex(
    /^[1-9][0-9]{0,14}$/,
    'Must be a positive whole number of kobo as a string, e.g. "1000000" for ₦10,000.00',
  )
  .transform((value) => BigInt(value));

export const currency = z.enum(CURRENCIES);

/** A resource ID in a route, e.g. `/wallets/:id`. */
export const uuid = z.uuid();

/** Cursor pagination query (`?limit=20&cursor=...`). Query values arrive as strings. */
export const pagination = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
