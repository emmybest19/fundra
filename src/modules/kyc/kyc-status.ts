// The KYC status lifecycle. `status` describes the latest request; `tier` is what has been
// approved. Every status change goes through assertKycTransition, so the allowed transitions
// live in one table.
import { ConflictError } from '../../common/errors/index.ts';
import type { KycStatus } from '../../generated/prisma/client.ts';

/**
 * NOT_STARTED → APPROVED             Tier 1, decided at once (an under-age date is a 422,
 *                                     not a rejection)
 * APPROVED/REJECTED → APPROVED/REJECTED  Tier 2, decided at once by the provider
 * APPROVED/REJECTED → PENDING        Tier 3 submitted, queued for review
 * PENDING → IN_REVIEW                a reviewer opens the case
 * IN_REVIEW → APPROVED/REJECTED      the reviewer decides
 *
 * A rejection never lowers `tier`: rejected at Tier 2, the user is still Tier 1.
 */
export const KYC_TRANSITIONS: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  NOT_STARTED: ['APPROVED'],
  APPROVED: ['APPROVED', 'REJECTED', 'PENDING'],
  REJECTED: ['APPROVED', 'REJECTED', 'PENDING'],
  PENDING: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'REJECTED'],
};

/** A submission is with Fundra: documents and the address can't change until it's decided. */
export const UNDER_REVIEW: readonly KycStatus[] = ['PENDING', 'IN_REVIEW'];

export function canKycTransition(from: KycStatus, to: KycStatus): boolean {
  return KYC_TRANSITIONS[from].includes(to);
}

export function assertKycTransition(from: KycStatus, to: KycStatus): void {
  if (!canKycTransition(from, to)) {
    throw new ConflictError(`A KYC request that is ${from} can't become ${to}.`);
  }
}
