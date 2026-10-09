// Holds: money reserved for an operation still in flight (e.g. a withdrawal waiting for the
// provider). Available drops when a hold is placed; the ledger doesn't move until it's
// settled (a real posting) or released (the money is spendable again). Like post(), every
// function runs inside the caller's transaction (docs/ARCHITECTURE.md §7.5).
//
// Locks: the transaction row first, then the wallet, the same order as post(). There is one
// hold per transaction, so the transaction-row lock serialises everything on a hold.
import type { Hold, Prisma } from '../../generated/prisma/client.ts';
import { LedgerRefusal, postEntries } from './ledger.service.ts';
import { lockTransactionRow, lockWalletRows } from './ledger.repository.ts';
import type {
  LockedTransaction,
  LockedWallet,
  PostingEntry,
  PostingResult,
} from './ledger.types.ts';
import { PostingInvariantError, walletStatusRefusal } from './ledger.utils.ts';

type Tx = Prisma.TransactionClient;

async function lockTransaction(tx: Tx, transactionId: string): Promise<LockedTransaction> {
  const transaction = await lockTransactionRow(tx, transactionId);
  if (transaction === undefined) {
    throw new PostingInvariantError(`transaction ${transactionId} does not exist`);
  }
  return transaction;
}

async function lockWallet(tx: Tx, walletId: string): Promise<LockedWallet> {
  const [wallet] = await lockWalletRows(tx, [walletId]);
  if (wallet === undefined) throw new PostingInvariantError(`wallet ${walletId} not found`);
  return wallet;
}

async function activeHoldOf(tx: Tx, transactionId: string): Promise<Hold> {
  const hold = await tx.hold.findUnique({ where: { transactionId } });
  if (hold === null) throw new PostingInvariantError(`transaction ${transactionId} has no hold`);
  if (hold.status !== 'ACTIVE') {
    throw new PostingInvariantError(
      `hold for transaction ${transactionId} is already ${hold.status}`,
    );
  }
  return hold;
}

/**
 * Reserves `amount` of the transaction's source wallet: available drops, ledger doesn't.
 * The wallet's status rules apply (a hold starts an outflow), and available must cover it.
 * Tier limits are the caller's job, under lockWallets(), before this.
 */
export async function placeHold(
  tx: Tx,
  request: { transactionId: string; walletId: string; amount: bigint; expiresAt?: Date },
): Promise<Hold> {
  if (typeof request.amount !== 'bigint' || request.amount <= 0n) {
    throw new PostingInvariantError('a hold amount must be a positive bigint');
  }
  const transaction = await lockTransaction(tx, request.transactionId);
  if (transaction.status !== 'PENDING' && transaction.status !== 'PROCESSING') {
    throw new PostingInvariantError(
      `transaction ${transaction.id} is ${transaction.status}; it can't take a hold`,
    );
  }
  if (transaction.sourceWalletId !== request.walletId) {
    throw new PostingInvariantError(
      `a hold must be on transaction ${transaction.id}'s source wallet`,
    );
  }
  if ((await tx.ledgerEntry.count({ where: { transactionId: transaction.id } })) > 0) {
    throw new PostingInvariantError(`transaction ${transaction.id} is already posted`);
  }
  if ((await tx.hold.count({ where: { transactionId: transaction.id } })) > 0) {
    throw new PostingInvariantError(`transaction ${transaction.id} already has a hold`);
  }

  const wallet = await lockWallet(tx, request.walletId);
  if (wallet.currency !== transaction.currency) {
    throw new PostingInvariantError(
      `wallet ${wallet.id} is ${wallet.currency}; the transaction is ${transaction.currency}`,
    );
  }
  const refusal = walletStatusRefusal(wallet.status, transaction.type);
  if (refusal !== null) throw new LedgerRefusal(refusal, wallet.id);
  if (wallet.availableBalance < request.amount) {
    throw new LedgerRefusal('INSUFFICIENT_FUNDS', wallet.id);
  }

  await tx.wallet.update({
    where: { id: wallet.id },
    data: { availableBalance: wallet.availableBalance - request.amount },
  });
  return tx.hold.create({
    data: {
      walletId: wallet.id,
      transactionId: transaction.id,
      amount: request.amount,
      expiresAt: request.expiresAt ?? null,
    },
  });
}

/**
 * The operation failed (or the hold expired, Stage 20): the money is spendable again.
 * Allowed whatever the wallet's status, like a reversal: it returns the user's own money.
 */
export async function releaseHold(tx: Tx, request: { transactionId: string }): Promise<Hold> {
  const transaction = await lockTransaction(tx, request.transactionId);
  const hold = await activeHoldOf(tx, transaction.id);
  const wallet = await lockWallet(tx, hold.walletId);
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { availableBalance: wallet.availableBalance + hold.amount },
  });
  return tx.hold.update({
    where: { id: hold.id },
    data: { status: 'RELEASED', resolvedAt: new Date() },
  });
}

/**
 * The operation succeeded: post the entries and close the hold. The held wallet's debit must
 * equal the hold exactly (fee included). Allowed even if the wallet was frozen after the
 * hold was placed: by now the money has really left (e.g. the provider paid out), so
 * refusing would leave the books wrong.
 */
export async function settleHold(
  tx: Tx,
  request: { transactionId: string; entries: readonly PostingEntry[] },
): Promise<{ hold: Hold; posting: PostingResult }> {
  const transaction = await lockTransaction(tx, request.transactionId);
  const hold = await activeHoldOf(tx, transaction.id);
  const posting = await postEntries(
    tx,
    { transactionId: transaction.id, entries: request.entries },
    { walletId: hold.walletId, amount: hold.amount },
  );
  const settled = await tx.hold.update({
    where: { id: hold.id },
    data: { status: 'SETTLED', resolvedAt: new Date() },
  });
  return { hold: settled, posting };
}
