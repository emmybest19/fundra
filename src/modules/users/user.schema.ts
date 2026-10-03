// Zod schemas for users: contact details and public identity, normalised to the forms the
// database CHECK constraints require (docs/DATABASE.md, users).
import { z } from 'zod';

/** Lower-cased and trimmed, so `Emma@Fundra.dev` and `emma@fundra.dev` are one account. */
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Must be at most 254 characters')
  .pipe(z.email('Must be a valid email address'));

/**
 * E.164 (`+2348012345678`). Nigerian local numbers (`08012345678`) are converted, and
 * spaces, dashes and brackets are ignored.
 */
export const phone = z
  .string()
  .transform((value) => value.replace(/[\s\-()]/g, ''))
  .transform((value) => (/^0\d{10}$/.test(value) ? `+234${value.slice(1)}` : value))
  .pipe(
    z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/, 'Must be a phone number like +2348012345678 or 08012345678'),
  );

/** D2: public handle, 3–20 of a-z, 0-9 and _. A leading @ is accepted and dropped. */
export const handle = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(/^[a-z0-9_]{3,20}$/, 'Must be 3–20 characters: letters, numbers and underscores'),
  );

export const personName = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(100, 'Must be at most 100 characters');
