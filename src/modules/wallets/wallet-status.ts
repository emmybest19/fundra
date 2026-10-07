// The wallet status lifecycle. Every status change goes through assertWalletTransition, so
// the allowed transitions live in one table. What each status lets money do is enforced by
// the ledger under the wallet lock (Stage 11).
import { ConflictError } from '../../common/errors/index.ts';
import type { WalletStatus } from '../../generated/prisma/client.ts';

/**
 * ACTIVE → FROZEN          an admin's compliance or fraud hold: no money in or out, except
 *                           reversals and refunds
 * FROZEN → ACTIVE          hold lifted
 * ACTIVE/FROZEN → CLOSED   the account is deactivated (by the user, Stage 8, or an admin)
 * CLOSED → ACTIVE          only when an admin reactivates the account (Stage 19); otherwise a
 *                           reactivated user could never hold money again, since one wallet
 *                           per (user, currency) is unique
 */
export const WALLET_TRANSITIONS: Readonly<Record<WalletStatus, readonly WalletStatus[]>> = {
  ACTIVE: ['FROZEN', 'CLOSED'],
  FROZEN: ['ACTIVE', 'CLOSED'],
  CLOSED: ['ACTIVE'],
};

export function canWalletTransition(from: WalletStatus, to: WalletStatus): boolean {
  return WALLET_TRANSITIONS[from].includes(to);
}

export function assertWalletTransition(from: WalletStatus, to: WalletStatus): void {
  if (!canWalletTransition(from, to)) {
    throw new ConflictError(`A wallet that is ${from} can't become ${to}.`);
  }
}
