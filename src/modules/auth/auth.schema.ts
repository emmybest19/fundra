// Zod request schemas for auth.
import { z } from 'zod';
import { email, handle, personName, phone } from '../users/user.schema.ts';
import { password, passwordIsNotPersonal } from './password.ts';

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
