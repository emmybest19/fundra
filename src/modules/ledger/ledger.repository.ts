// Ledger persistence, including row locking via raw SQL (Prisma has no API for row locks).
// The only raw-SQL repository in Fundra: kept small, and only for what Prisma can't do.
import type { Prisma } from '../../generated/prisma/client.ts';
import type { LockedTransaction, LockedWallet } from './ledger.types.ts';

type Tx = Prisma.TransactionClient;

/** Locks a transaction row, so two postings for it can't run at once. */
export async function lockTransactionRow(
  tx: Tx,
  transactionId: string,
): Promise<LockedTransaction | undefined> {
  const [row] = await tx.$queryRaw<LockedTransaction[]>`
    SELECT id, type, status, currency, source_wallet_id AS "sourceWalletId"
    FROM transactions WHERE id = ${transactionId}::uuid
    FOR UPDATE`;
  return row;
}

/**
 * Locks wallets in **ascending ID order**, whatever order they were asked for in: two
 * postings touching the same wallets always queue in the same order, so A→B and B→A can't
 * deadlock. Re-locking a wallet already locked in this transaction is a no-op.
 */
export async function lockWalletRows(
  tx: Tx,
  walletIds: readonly string[],
): Promise<LockedWallet[]> {
  if (walletIds.length === 0) return [];
  const ids = [...new Set(walletIds)].sort();
  return tx.$queryRaw<LockedWallet[]>`
    SELECT id,
           user_id           AS "userId",
           ledger_account_id AS "ledgerAccountId",
           currency,
           status,
           ledger_balance    AS "ledgerBalance",
           available_balance AS "availableBalance"
    FROM wallets WHERE id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE`;
}
