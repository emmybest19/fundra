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

// ─── What the user sees ───────────────────────────────────────────────────────────────────

/**
 * One transaction from the caller's side. Amounts are kobo strings (D1). Nothing that belongs
 * to the other party is shown: no wallet IDs, account numbers or user IDs, only their public
 * name and handle.
 */
export interface TransactionView {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  /** Relative to the caller: IN = money arriving in their wallet, OUT = leaving it. */
  direction: 'IN' | 'OUT';
  amount: string;
  /** The caller's fee: "0" on money arriving (the sender paid it). */
  fee: string;
  /** What left (amount + fee) or arrived (amount). */
  total: string;
  currency: string;
  description: string | null;
  /** Only on the caller's own outgoing items. */
  failureReason: string | null;
  counterparty: { name: string; handle: string } | null;
  reversalOf: { id: string; reference: string } | null;
  /** The caller's ledger balance after this posting; null until it posts. */
  balanceAfter: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

interface PartyWallet {
  id: string;
  user: { firstName: string; lastName: string; handle: string };
}

export type TransactionWithParties = Transaction & {
  sourceWallet: PartyWallet | null;
  destinationWallet: PartyWallet | null;
  reversalOf: { id: string; reference: string } | null;
};

export function toTransactionView(
  row: TransactionWithParties,
  myWalletIds: ReadonlySet<string>,
  balanceAfter: bigint | null,
): TransactionView {
  const out = row.sourceWalletId !== null && myWalletIds.has(row.sourceWalletId);
  const other = out ? row.destinationWallet : row.sourceWallet;
  const fee = out ? row.fee : 0n;
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    direction: out ? 'OUT' : 'IN',
    amount: row.amount.toString(),
    fee: fee.toString(),
    total: (row.amount + fee).toString(),
    currency: row.currency,
    description: row.description,
    failureReason: out ? row.failureReason : null,
    counterparty:
      other === null || myWalletIds.has(other.id)
        ? null
        : { name: `${other.user.firstName} ${other.user.lastName}`, handle: other.user.handle },
    reversalOf: row.reversalOf,
    balanceAfter: balanceAfter?.toString() ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
