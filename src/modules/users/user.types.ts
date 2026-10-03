// Types for users.
import type { User } from '../../generated/prisma/client.ts';

/** What the API may show about a user to that user. Never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  phoneVerified: boolean;
  handle: string;
  firstName: string;
  lastName: string;
  status: User['status'];
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    phone: user.phone,
    phoneVerified: user.phoneVerifiedAt !== null,
    handle: user.handle,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
