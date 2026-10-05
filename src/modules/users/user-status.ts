// The account status lifecycle. Every status change goes through assertStatusTransition, so
// the allowed transitions live in one table instead of being implied by scattered updates.
import { ConflictError } from '../../common/errors/index.ts';
import type { User, UserStatus } from '../../generated/prisma/client.ts';

/**
 * PENDING_VERIFICATION → ACTIVE      email and phone verified (Stage 7)
 * any live status      → SUSPENDED   by an admin (Stage 19)
 * any live status      → DEACTIVATED by the user, or an admin
 * SUSPENDED/DEACTIVATED → ACTIVE or PENDING_VERIFICATION, by an admin (reactivation, Stage 19)
 *
 * ACTIVE never returns to PENDING_VERIFICATION: a verified contact is only ever replaced by
 * another verified one (contact change confirms the new address with a code).
 */
export const STATUS_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> = {
  PENDING_VERIFICATION: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'PENDING_VERIFICATION', 'DEACTIVATED'],
  DEACTIVATED: ['ACTIVE', 'PENDING_VERIFICATION'],
};

export function canTransition(from: UserStatus, to: UserStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(from: UserStatus, to: UserStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`An account that is ${from} can't become ${to}.`);
  }
}

/**
 * The status a user should have once their contact details are as given: a pending account
 * with both email and phone verified becomes ACTIVE; anything else is unchanged.
 */
export function statusAfterVerification(
  user: Pick<User, 'status' | 'emailVerifiedAt' | 'phoneVerifiedAt'>,
): UserStatus {
  return user.status === 'PENDING_VERIFICATION' &&
    user.emailVerifiedAt !== null &&
    user.phoneVerifiedAt !== null
    ? 'ACTIVE'
    : user.status;
}
