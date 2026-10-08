// Ledger helpers: account codes (see docs/DATABASE.md, ledger_accounts.code) and the pure
// posting rules that ledger.service applies.
import type {
  EntryDirection,
  LedgerAccountType,
  TransactionType,
  WalletStatus,
} from '../../generated/prisma/client.ts';
import type { PostingEntry } from './ledger.types.ts';

export const walletAccountCode = (walletId: string): string => `WALLET:${walletId}`;

export const providerSettlementAccountCode = (providerCode: string, currency: string): string =>
  `PROVIDER_SETTLEMENT:${providerCode}:${currency}`;

export const feeRevenueAccountCode = (currency: string): string => `FEE_REVENUE:${currency}`;

export const suspenseAccountCode = (currency: string): string => `SUSPENSE:${currency}`;

// ─── Posting rules (pure; ledger.service applies them) ────────────────────────────────────

/**
 * A posting that breaks an invariant is a bug in the caller, not a user error: it surfaces
 * as a 500, never as a business message.
 */
export class PostingInvariantError extends Error {
  constructor(message: string) {
    super(`Invalid ledger posting: ${message}`);
    this.name = 'PostingInvariantError';
  }
}

/**
 * Invariants checkable without the database: at least two entries, every amount > 0,
 * Σ debits = Σ credits (invariant 1), and each account at most once.
 */
export function assertValidEntries(entries: readonly PostingEntry[]): void {
  if (entries.length < 2) throw new PostingInvariantError('needs at least two entries');
  const seen = new Set<string>();
  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (typeof entry.amount !== 'bigint' || entry.amount <= 0n) {
      throw new PostingInvariantError('every amount must be a positive bigint');
    }
    if (seen.has(entry.ledgerAccountId)) {
      throw new PostingInvariantError(`account ${entry.ledgerAccountId} appears twice`);
    }
    seen.add(entry.ledgerAccountId);
    if (entry.direction === 'DEBIT') debits += entry.amount;
    else credits += entry.amount;
  }
  if (debits !== credits) {
    throw new PostingInvariantError(
      `unbalanced: debits ${debits.toString()} ≠ credits ${credits.toString()}`,
    );
  }
}

/**
 * How an entry changes its account's balance. Assets and expenses grow with debits;
 * liabilities (every wallet) and revenue grow with credits.
 */
export function balanceChange(
  type: LedgerAccountType,
  direction: EntryDirection,
  amount: bigint,
): bigint {
  const creditNormal = type === 'LIABILITY' || type === 'REVENUE';
  return (direction === 'CREDIT') === creditNormal ? amount : -amount;
}

/** Postings a frozen wallet still accepts: they return money, so blocking them strands it. */
export const FROZEN_WALLET_EXEMPT_TYPES: readonly TransactionType[] = ['REVERSAL', 'REFUND'];

/** Why a wallet in this status refuses this posting, or null if it may take part. */
export function walletStatusRefusal(
  status: WalletStatus,
  transactionType: TransactionType,
): 'WALLET_CLOSED' | 'WALLET_FROZEN' | null {
  switch (status) {
    case 'ACTIVE':
      return null;
    case 'CLOSED':
      return 'WALLET_CLOSED';
    case 'FROZEN':
      return FROZEN_WALLET_EXEMPT_TYPES.includes(transactionType) ? null : 'WALLET_FROZEN';
  }
}
