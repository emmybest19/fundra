// Zod request schemas for kyc.
import { z } from 'zod';

/** A real calendar date as `YYYY-MM-DD` (2001-02-29 is rejected, not rolled over). */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 1995-04-12')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'Must be a real calendar date')
  .refine((value) => value >= '1900-01-01', 'Must be after 1900');

/** Tier 1. The 18+ rule needs "today", so the service checks it. */
export const tier1Body = z.strictObject({ dateOfBirth: calendarDate });

/** Both are 11 digits. Spaces are tolerated because people copy them from cards. */
export const tier2Body = z.strictObject({
  type: z.enum(['BVN', 'NIN']),
  idNumber: z
    .string()
    .transform((value) => value.replace(/\s/g, ''))
    .pipe(z.string().regex(/^\d{11}$/, 'Must be 11 digits')),
});

export type Tier2Input = z.output<typeof tier2Body>;

const addressLine = z.string().trim().min(1, 'Required').max(200, 'Must be at most 200 characters');

/** Tier 3: proven by the utility bill uploaded alongside. */
export const tier3Body = z.strictObject({
  address: z.strictObject({
    line1: addressLine,
    line2: addressLine.optional(),
    city: addressLine,
    state: addressLine,
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'Must be a two-letter country code like NG')
      .default('NG'),
    postalCode: z.string().trim().min(1).max(20, 'Must be at most 20 characters').optional(),
  }),
});

export type Tier3Input = z.output<typeof tier3Body>;

export const documentParams = z.strictObject({
  type: z.enum(
    ['NATIONAL_ID', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'UTILITY_BILL', 'SELFIE'],
    {
      message:
        'Must be one of NATIONAL_ID, PASSPORT, DRIVERS_LICENSE, VOTERS_CARD, UTILITY_BILL, SELFIE',
    },
  ),
});
