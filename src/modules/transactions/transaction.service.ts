// Business logic for transactions: the central record of every money operation. Creation and
// status changes run inside the caller's transaction, next to the ledger posting they belong
// to (Stage 13 transfers, Stage 14 payments). The ledger (src/modules/ledger) moves the money;
// this module records what the operation is and where it stands.
import { ConflictError } from '../../common/errors/index.ts';
import type { Prisma, Transaction, TransactionStatus } from '../../generated/prisma/client.ts';
import {
  canTransactionTransition,
  generateReference,
  TRANSACTION_SHAPES,
  TransactionInvariantError,
  type NewTransaction,
} from './transaction.types.ts';

type Tx = Prisma.TransactionClient;

/** Fresh references to try: 16.7M a day, so five clashes in a row means a bug. */
const REFERENCE_ATTEMPTS = 5;
export const DESCRIPTION_MAX_LENGTH = 140;
export const FAILURE_REASON_MAX_LENGTH = 500;

/**
 * Creates a PENDING transaction with a fresh reference, after checking its shape: the wallets
 * its type needs (and only those), in its currency; a REVERSAL mirrors a COMPLETED original.
 * The database repeats the essentials (CHECKs on amount, fee, reference, distinct wallets).
 */
export async function createTransaction(
  tx: Tx,
  input: NewTransaction,
  now: number = Date.now(),
): Promise<Transaction> {
  const fee = input.fee ?? 0n;
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) {
    throw new TransactionInvariantError('amount must be a positive bigint');
  }
  if (typeof fee !== 'bigint' || fee < 0n) {
    throw new TransactionInvariantError('fee must be a non-negative bigint');
  }
  const source = input.sourceWalletId ?? null;
  const destination = input.destinationWalletId ?? null;
  const reversalOfId = input.reversalOfId ?? null;
  const description = input.description?.trim() ?? null;
  if (description !== null && description.length > DESCRIPTION_MAX_LENGTH) {
    throw new TransactionInvariantError(
      `description is over ${String(DESCRIPTION_MAX_LENGTH)} characters`,
    );
  }

  if (input.type === 'REVERSAL') {
    await assertMirrorsOriginal(tx, {
      reversalOfId,
      source,
      destination,
      currency: input.currency,
      amount: input.amount,
      fee,
    });
  } else {
    if (reversalOfId !== null)
      throw new TransactionInvariantError('only a REVERSAL has reversalOfId');
    const shape = TRANSACTION_SHAPES[input.type];
    if ((shape.source === 'required') !== (source !== null)) {
      throw new TransactionInvariantError(
        `a ${input.type} ${shape.source === 'required' ? 'needs' : "can't have"} a source wallet`,
      );
    }
    if ((shape.destination === 'required') !== (destination !== null)) {
      throw new TransactionInvariantError(
        `a ${input.type} ${shape.destination === 'required' ? 'needs' : "can't have"} a destination wallet`,
      );
    }
  }
  if (source !== null && source === destination) {
    throw new TransactionInvariantError('source and destination must differ');
  }
  await assertWalletCurrency(tx, [source, destination], input.currency);

  return tx.transaction.create({
    data: {
      reference: await freeReference(tx, now),
      type: input.type,
      currency: input.currency,
      amount: input.amount,
      fee,
      sourceWalletId: source,
      destinationWalletId: destination,
      initiatedByUserId: input.initiatedByUserId ?? null,
      reversalOfId,
      description,
      metadata: input.metadata ?? {},
    },
  });
}

/**
 * Moves a transaction to `to` through the status table, under a row lock, after checking the
 * money behind it: COMPLETED needs its ledger posting and no active hold; FAILED and CANCELLED
 * need no posting and no active hold (release it first); REVERSED needs a COMPLETED reversal.
 * An illegal move (e.g. a duplicate webhook finishing a finished transaction) is a 409.
 */
export async function transitionTransaction(
  tx: Tx,
  transactionId: string,
  to: TransactionStatus,
  options: { failureReason?: string; now?: number } = {},
): Promise<Transaction> {
  const [row] = await tx.$queryRaw<{ status: TransactionStatus }[]>`
    SELECT status FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
  if (row === undefined)
    throw new TransactionInvariantError(`transaction ${transactionId} does not exist`);
  if (!canTransactionTransition(row.status, to)) {
    throw new ConflictError(`A transaction that is ${row.status} can't become ${to}.`);
  }

  const failureReason = options.failureReason?.trim();
  if (to === 'FAILED') {
    if (
      failureReason === undefined ||
      failureReason.length === 0 ||
      failureReason.length > FAILURE_REASON_MAX_LENGTH
    ) {
      throw new TransactionInvariantError(
        `FAILED needs a failure reason of 1–${String(FAILURE_REASON_MAX_LENGTH)} characters`,
      );
    }
  } else if (failureReason !== undefined) {
    throw new TransactionInvariantError('only FAILED takes a failure reason');
  }

  if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED') {
    const [entries, activeHold] = await Promise.all([
      tx.ledgerEntry.count({ where: { transactionId } }),
      tx.hold.count({ where: { transactionId, status: 'ACTIVE' } }),
    ]);
    if (activeHold > 0) {
      throw new TransactionInvariantError(
        `transaction ${transactionId} still has an ACTIVE hold; settle or release it first`,
      );
    }
    if (to === 'COMPLETED' && entries === 0) {
      throw new TransactionInvariantError(
        `transaction ${transactionId} can't complete: nothing was posted`,
      );
    }
    if (to !== 'COMPLETED' && entries > 0) {
      throw new TransactionInvariantError(
        `transaction ${transactionId} was posted; reverse it instead of ${to === 'FAILED' ? 'failing' : 'cancelling'} it`,
      );
    }
  }
  if (to === 'REVERSED') {
    const reversal = await tx.transaction.findUnique({
      where: { reversalOfId: transactionId },
      select: { status: true },
    });
    if (reversal?.status !== 'COMPLETED') {
      throw new TransactionInvariantError(`transaction ${transactionId} has no COMPLETED reversal`);
    }
  }

  return tx.transaction.update({
    where: { id: transactionId },
    data: {
      status: to,
      ...(to === 'COMPLETED' ? { completedAt: new Date(options.now ?? Date.now()) } : {}),
      ...(to === 'FAILED' ? { failureReason: failureReason ?? null } : {}),
    },
  });
}

/** A reversal undoes a COMPLETED, non-reversal original: same currency, wallets swapped. */
async function assertMirrorsOriginal(
  tx: Tx,
  r: {
    reversalOfId: string | null;
    source: string | null;
    destination: string | null;
    currency: string;
    amount: bigint;
    fee: bigint;
  },
): Promise<void> {
  if (r.reversalOfId === null) throw new TransactionInvariantError('a REVERSAL needs reversalOfId');
  const original = await tx.transaction.findUnique({ where: { id: r.reversalOfId } });
  if (original === null)
    throw new TransactionInvariantError(`transaction ${r.reversalOfId} does not exist`);
  if (original.type === 'REVERSAL')
    throw new TransactionInvariantError("a reversal can't be reversed");
  if (original.status !== 'COMPLETED') {
    throw new TransactionInvariantError(
      `only a COMPLETED transaction can be reversed; ${original.id} is ${original.status}`,
    );
  }
  if (original.currency !== r.currency)
    throw new TransactionInvariantError('a reversal keeps its original currency');
  if (r.source !== original.destinationWalletId || r.destination !== original.sourceWalletId) {
    throw new TransactionInvariantError(
      'a reversal swaps its original’s source and destination wallets',
    );
  }
  if (r.amount + r.fee > original.amount + original.fee) {
    throw new TransactionInvariantError('a reversal can’t move more than its original');
  }
}

async function assertWalletCurrency(
  tx: Tx,
  ids: readonly (string | null)[],
  currency: string,
): Promise<void> {
  const wanted = ids.filter((id): id is string => id !== null);
  if (wanted.length === 0) return;
  const wallets = await tx.wallet.findMany({
    where: { id: { in: wanted } },
    select: { id: true, currency: true },
  });
  for (const id of wanted) {
    const wallet = wallets.find((w) => w.id === id);
    if (wallet === undefined) throw new TransactionInvariantError(`wallet ${id} does not exist`);
    if (wallet.currency !== currency) {
      throw new TransactionInvariantError(
        `wallet ${id} is ${wallet.currency}; the transaction is ${currency}`,
      );
    }
  }
}

async function freeReference(tx: Tx, now: number): Promise<string> {
  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt++) {
    const reference = generateReference(now);
    const taken = await tx.transaction.findUnique({ where: { reference }, select: { id: true } });
    if (taken === null) return reference;
  }
  throw new Error(`No free transaction reference after ${String(REFERENCE_ATTEMPTS)} attempts`);
}
