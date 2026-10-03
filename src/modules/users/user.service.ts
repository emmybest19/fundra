// Business logic for users.
import type { Prisma, User } from '../../generated/prisma/client.ts';

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
