// Posts balanced ledger transactions; the only writer of ledger entries and wallet balances
// (docs/ARCHITECTURE.md §7). Runs inside the caller's transaction, so a money movement's
// transaction row, entries, balances, audit row and events commit together or not at all.
import { ErrorCode, UnprocessableError } from '../../common/errors/index.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import { lockTransactionRow, lockWalletRows } from './ledger.repository.ts';
import type {
  AccountInfo,
  LockedWallet,
  PostedWallet,
  PostingRequest,
  PostingResult,
} from './ledger.types.ts';
import {
  assertValidEntries,
  balanceChange,
  PostingInvariantError,
  walletStatusRefusal,
} from './ledger.utils.ts';

type Tx = Prisma.TransactionClient;

/** Transactions that may still receive their (single) posting. */
const POSTABLE_STATUSES = ['PENDING', 'PROCESSING'] as const;

/**
 * A wallet refused the posting. Carries the wallet, so the caller can tell a sender's own
 * problem (shown as is) from a recipient's (shown as RECIPIENT_CANNOT_RECEIVE).
 */
export class LedgerRefusal extends UnprocessableError {
  readonly walletId: string;

  constructor(code: 'INSUFFICIENT_FUNDS' | 'WALLET_FROZEN' | 'WALLET_CLOSED', walletId: string) {
    const messages = {
      INSUFFICIENT_FUNDS: 'Your available balance is too low for this transaction.',
      WALLET_FROZEN: 'This wallet is restricted. Contact support.',
      WALLET_CLOSED: 'This wallet is closed.',
    } as const;
    super(messages[code], { code: ErrorCode[code] });
    this.walletId = walletId;
  }
}

/** Locks wallets for a money movement (see lockWalletRows). Exported so callers can check
 *  limits against locked balances before posting; post() takes the same locks again. */
export function lockWallets(tx: Tx, walletIds: readonly string[]): Promise<LockedWallet[]> {
  return lockWalletRows(tx, walletIds);
}

/**
 * Posts a transaction's entries. In order: invariants → lock the transaction row (one
 * posting per transaction) → load accounts → lock wallets (ascending ID) → status rules and
 * funds, under the locks → insert entries → update cached balances. The database backs every
 * rule: the deferred balanced-entries trigger, balance CHECKs and append-only triggers.
 */
export async function post(tx: Tx, request: PostingRequest): Promise<PostingResult> {
  assertValidEntries(request.entries);

  const transaction = await lockTransactionRow(tx, request.transactionId);
  if (transaction === undefined) {
    throw new PostingInvariantError(`transaction ${request.transactionId} does not exist`);
  }
  if (!(POSTABLE_STATUSES as readonly string[]).includes(transaction.status)) {
    throw new PostingInvariantError(
      `transaction ${transaction.id} is ${transaction.status}; only PENDING or PROCESSING can be posted`,
    );
  }
  // One posting per transaction: a retried request can never post twice.
  const already = await tx.ledgerEntry.count({ where: { transactionId: transaction.id } });
  if (already > 0) {
    throw new PostingInvariantError(`transaction ${transaction.id} is already posted`);
  }

  const accounts = await loadAccounts(
    tx,
    request.entries.map((e) => e.ledgerAccountId),
  );
  for (const account of accounts.values()) {
    if (account.currency !== transaction.currency) {
      throw new PostingInvariantError(
        `account ${account.id} is ${account.currency}; the transaction is ${transaction.currency}`,
      );
    }
  }

  const walletIds = [...accounts.values()].flatMap((a) =>
    a.walletId === null ? [] : [a.walletId],
  );
  const wallets = new Map((await lockWalletRows(tx, walletIds)).map((w) => [w.id, w]));

  // Net change per wallet. Each account appears once, so it's one entry's change.
  const changes = new Map<string, bigint>();
  for (const entry of request.entries) {
    const account = accounts.get(entry.ledgerAccountId);
    const walletId = account?.walletId ?? null;
    if (account === undefined || walletId === null) continue;
    changes.set(walletId, balanceChange(account.type, entry.direction, entry.amount));
  }

  // Under the locks: status first (a frozen wallet is refused even with funds), then funds.
  for (const walletId of [...changes.keys()].sort()) {
    const wallet = wallets.get(walletId);
    if (wallet === undefined) throw new PostingInvariantError(`wallet ${walletId} not found`);
    const refusal = walletStatusRefusal(wallet.status, transaction.type);
    if (refusal !== null) throw new LedgerRefusal(refusal, walletId);
  }
  for (const [walletId, change] of changes) {
    const wallet = wallets.get(walletId);
    // Available, not ledger: money on hold is already promised elsewhere.
    if (wallet !== undefined && wallet.availableBalance + change < 0n) {
      throw new LedgerRefusal('INSUFFICIENT_FUNDS', walletId);
    }
  }

  const entryIds: string[] = [];
  const posted: PostedWallet[] = [];
  for (const entry of request.entries) {
    const walletId = accounts.get(entry.ledgerAccountId)?.walletId ?? null;
    const wallet = walletId === null ? undefined : wallets.get(walletId);
    const change = wallet === undefined ? 0n : (changes.get(wallet.id) ?? 0n);
    const created = await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        ledgerAccountId: entry.ledgerAccountId,
        direction: entry.direction,
        amount: entry.amount,
        currency: transaction.currency,
        // Wallets only: they're locked, so "balance after" is exact. System accounts aren't.
        balanceAfter: wallet === undefined ? null : wallet.ledgerBalance + change,
      },
      select: { id: true },
    });
    entryIds.push(created.id);
  }

  for (const [walletId, change] of changes) {
    const wallet = wallets.get(walletId);
    if (wallet === undefined) continue;
    const updated = await tx.wallet.update({
      where: { id: walletId },
      data: {
        ledgerBalance: wallet.ledgerBalance + change,
        availableBalance: wallet.availableBalance + change,
      },
      select: { id: true, ledgerBalance: true, availableBalance: true },
    });
    posted.push({
      walletId: updated.id,
      ledgerBalance: updated.ledgerBalance,
      availableBalance: updated.availableBalance,
    });
  }

  return { transactionId: transaction.id, entryIds, wallets: posted };
}

async function loadAccounts(tx: Tx, ids: readonly string[]): Promise<Map<string, AccountInfo>> {
  const rows = await tx.ledgerAccount.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, type: true, currency: true, wallets: { select: { id: true } } },
  });
  const accounts = new Map<string, AccountInfo>(
    rows.map((row) => [
      row.id,
      { id: row.id, type: row.type, currency: row.currency, walletId: row.wallets[0]?.id ?? null },
    ]),
  );
  const missing = ids.filter((id) => !accounts.has(id));
  if (missing.length > 0) throw new PostingInvariantError(`unknown accounts ${missing.join(', ')}`);
  return accounts;
}
