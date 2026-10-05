// Zod request schemas for auth.
import { z } from 'zod';
import { email, handle, personName, phone } from '../users/user.schema.ts';
import { otpCode } from './otp.ts';
import { currentPassword, password, passwordIsNotPersonal } from './password.ts';

export { otpCode };

export const registerBody = z
  .strictObject({
    email,
    phone,
    handle,
    firstName: personName,
    lastName: personName,
    password,
  })
  .refine((body) => passwordIsNotPersonal(body.password, body), {
    path: ['password'],
    message: 'Must not contain your handle or email name',
  });

export type RegisterInput = z.output<typeof registerBody>;

export const loginBody = z.strictObject({
  /** Email or phone (any accepted format). */
  identifier: z.string().trim().min(1, 'Required').max(254),
  password: currentPassword,
  /** Client-generated stable ID for this device, so sessions can be recognised later. */
  deviceId: z.string().trim().min(1).max(128).optional(),
  deviceName: z.string().trim().min(1).max(100).optional(),
});

export type LoginInput = z.output<typeof loginBody>;

export const confirmCodeBody = z.strictObject({ code: otpCode });

export const forgotPasswordBody = z.strictObject({
  identifier: z.string().trim().min(1, 'Required').max(254),
});

/** The personal-data rule needs the account, so the service checks it after lookup. */
export const resetPasswordBody = z.strictObject({
  identifier: z.string().trim().min(1, 'Required').max(254),
  code: otpCode,
  newPassword: password,
});

/** For /refresh and /logout. */
export const refreshTokenBody = z.strictObject({
  refreshToken: z.string().min(1, 'Required').max(200),
});
