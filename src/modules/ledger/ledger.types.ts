// Ledger types: accounts, entries, posting instructions.
import type {
  EntryDirection,
  LedgerAccountType,
  TransactionStatus,
  TransactionType,
  WalletStatus,
} from '../../generated/prisma/client.ts';

export interface PostingEntry {
  ledgerAccountId: string;
  direction: EntryDirection;
  /** Kobo, > 0. The direction carries the sign. */
  amount: bigint;
}

export interface PostingRequest {
  /** An existing transaction row. Its type and currency are read from it, never passed in. */
  transactionId: string;
  entries: readonly PostingEntry[];
}

/** A wallet row as read under `FOR UPDATE`. */
export interface LockedWallet {
  id: string;
  userId: string;
  ledgerAccountId: string;
  currency: string;
  status: WalletStatus;
  ledgerBalance: bigint;
  availableBalance: bigint;
}

export interface LockedTransaction {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  currency: string;
  sourceWalletId: string | null;
}

/** Internal: post() settling a hold (see holds.ts). */
export interface SettlingHold {
  walletId: string;
  amount: bigint;
}

export interface PostedWallet {
  walletId: string;
  ledgerBalance: bigint;
  availableBalance: bigint;
}

export interface PostingResult {
  transactionId: string;
  entryIds: string[];
  wallets: PostedWallet[];
}

export interface AccountInfo {
  id: string;
  type: LedgerAccountType;
  currency: string;
  /** Set when this is a wallet's account. */
  walletId: string | null;
}
