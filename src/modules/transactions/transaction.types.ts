// Types for transactions: the status lifecycle, references and the shape of each type.
import { randomBytes } from 'node:crypto';
import { lagosDate } from '../../common/utils/business-day.ts';
import type {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../../generated/prisma/client.ts';

/**
 * Status lifecycle (docs/ARCHITECTURE.md §7.8). One addition to the diagram: an instant
 * operation (a P2P transfer) is created, posted and finished in one database transaction,
 * so PENDING can go straight to COMPLETED or FAILED.
 *
 * PENDING    → PROCESSING (handed to a provider), COMPLETED, FAILED, CANCELLED
 * PROCESSING → COMPLETED, FAILED
 * COMPLETED  → REVERSED (once a linked REVERSAL transaction has completed)
 * FAILED, CANCELLED, REVERSED: final
 */
export const TRANSACTION_TRANSITIONS: Readonly<
  Record<TransactionStatus, readonly TransactionStatus[]>
> = {
  PENDING: ['PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['REVERSED'],
  FAILED: [],
  CANCELLED: [],
  REVERSED: [],
};

export function canTransactionTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

/**
 * A caller broke a transaction rule (wrong shape, completing without postings, …): a bug,
 * surfaced as a 500, never a user-facing message. User input is validated before this.
 */
export class TransactionInvariantError extends Error {
  constructor(message: string) {
    super(`Invalid transaction: ${message}`);
    this.name = 'TransactionInvariantError';
  }
}

// ─── References ───────────────────────────────────────────────────────────────────────────

/** `FND-TRX-20261014-8F92A1`: the Lagos business date + 6 random hex digits (16.7M a day). */
export const REFERENCE_PATTERN = /^FND-TRX-[0-9]{8}-[0-9A-F]{6}$/;

export function generateReference(now: number): string {
  return `FND-TRX-${lagosDate(now).replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

// ─── Shapes ───────────────────────────────────────────────────────────────────────────────

type Presence = 'required' | 'forbidden';

/** Which wallets each type moves money between. Reversals mirror their original instead. */
export const TRANSACTION_SHAPES: Readonly<
  Record<Exclude<TransactionType, 'REVERSAL'>, { source: Presence; destination: Presence }>
> = {
  DEPOSIT: { source: 'forbidden', destination: 'required' },
  WITHDRAWAL: { source: 'required', destination: 'forbidden' },
  TRANSFER: { source: 'required', destination: 'required' },
  PAYMENT: { source: 'required', destination: 'forbidden' },
  REFUND: { source: 'forbidden', destination: 'required' },
  FEE: { source: 'required', destination: 'forbidden' },
};

export interface NewTransaction {
  type: TransactionType;
  currency: string;
  /** Principal, kobo, > 0. */
  amount: bigint;
  /** Kobo, ≥ 0 (D6). The source is debited amount + fee. */
  fee?: bigint;
  sourceWalletId?: string | null;
  destinationWalletId?: string | null;
  initiatedByUserId?: string | null;
  /** REVERSAL only: the COMPLETED transaction it undoes. */
  reversalOfId?: string | null;
  /** User narration, ≤ 140 characters. */
  description?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export type TransactionRow = Transaction;
