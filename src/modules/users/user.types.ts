// Types for users.
import { isRoleName, type RoleName } from '../../common/constants/rbac.ts';
import type { KycStatus, User } from '../../generated/prisma/client.ts';

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

/** GET /users/me: the public view plus what the account can do next. */
export interface UserProfile extends PublicUser {
  roles: RoleName[];
  kyc: { status: KycStatus; tier: number };
  /** Same rule as requireActiveAccount: only ACTIVE accounts can move money. */
  canTransact: boolean;
  updatedAt: string;
}

export type UserWithAccess = User & {
  roles: { role: { name: string } }[];
  kycProfile: { status: KycStatus; tier: number } | null;
};

/** Prisma `include` that loads everything toUserProfile needs. */
export const PROFILE_INCLUDE = {
  roles: { select: { role: { select: { name: true } } } },
  kycProfile: { select: { status: true, tier: true } },
} as const;

export function toUserProfile(user: UserWithAccess): UserProfile {
  return {
    ...toPublicUser(user),
    roles: user.roles.map((r) => r.role.name).filter(isRoleName),
    // Every user gets a KYC profile at registration; tier 0 if it's somehow missing.
    kyc: { status: user.kycProfile?.status ?? 'NOT_STARTED', tier: user.kycProfile?.tier ?? 0 },
    canTransact: user.status === 'ACTIVE',
    updatedAt: user.updatedAt.toISOString(),
  };
}
