// Zod schemas for users: contact details and public identity, normalised to the forms the
// database CHECK constraints require (docs/DATABASE.md, users).
import { z } from 'zod';
import { otpCode } from '../auth/otp.ts';
import { currentPassword, password } from '../auth/password.ts';

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

/** PATCH /users/me: any of the editable profile fields, at least one. */
export const updateProfileBody = z
  .strictObject({
    firstName: personName.optional(),
    lastName: personName.optional(),
    handle: handle.optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    'Send at least one field to update',
  );

export type UpdateProfileInput = z.output<typeof updateProfileBody>;

export const requestEmailChangeBody = z.strictObject({
  newEmail: email,
  password: currentPassword,
});

export const confirmEmailChangeBody = z.strictObject({ newEmail: email, code: otpCode });

export const requestPhoneChangeBody = z.strictObject({
  newPhone: phone,
  password: currentPassword,
});

export const confirmPhoneChangeBody = z.strictObject({ newPhone: phone, code: otpCode });

/** Optional and from a fixed list: free text here would be personal data kept forever in audit. */
export const DEACTIVATION_REASONS = [
  'NO_LONGER_NEEDED',
  'SWITCHING_PROVIDER',
  'PRIVACY_CONCERNS',
  'TOO_EXPENSIVE',
  'OTHER',
] as const;

export const deactivateBody = z.strictObject({
  password: currentPassword,
  reason: z.enum(DEACTIVATION_REASONS).optional(),
});

/**
 * Change password while signed in. The new one follows the registration policy; the
 * personal-data and "not the same as before" rules need the account, so the service checks
 * them.
 */
export const changePasswordBody = z.strictObject({
  currentPassword,
  newPassword: password,
});
