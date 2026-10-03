// Business logic for users.
import type { Prisma, PrismaClient, User } from '../../generated/prisma/client.ts';
import { email, phone } from './user.schema.ts';

/**
 * Finds a user by email (if the identifier contains @) or phone, in any accepted format.
 * Unparseable input finds nobody rather than erroring, so callers can't distinguish
 * "malformed" from "unknown" for an attacker.
 */
export async function findUserByIdentifier(
  db: Pick<PrismaClient, 'user'>,
  identifier: string,
): Promise<User | null> {
  if (identifier.includes('@')) {
    const parsed = email.safeParse(identifier);
    return parsed.success ? db.user.findUnique({ where: { email: parsed.data } }) : null;
  }
  const parsed = phone.safeParse(identifier);
  return parsed.success ? db.user.findUnique({ where: { phone: parsed.data } }) : null;
}

export const isDisabled = (user: Pick<User, 'status'>): boolean =>
  user.status === 'SUSPENDED' || user.status === 'DEACTIVATED';

export interface NewUser {
  email: string;
  phone: string;
  handle: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
}

/**
 * Creates a customer: the user (PENDING_VERIFICATION until email/phone are verified), an
 * empty KYC profile (tier 0: no wallet yet) and the USER role. Runs in the caller's
 * transaction so registration never leaves a half-created account.
 */
export async function createUser(tx: Prisma.TransactionClient, input: NewUser): Promise<User> {
  const user = await tx.user.create({ data: input });
  await tx.kycProfile.create({ data: { userId: user.id } });
  // Seeded by prisma/seed.ts; a missing role is a deployment error, not a user error.
  const role = await tx.role.findUniqueOrThrow({ where: { name: 'USER' } });
  await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}
