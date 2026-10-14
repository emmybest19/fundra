// Business logic for transactions: the central record of every money operation. Creation and
// status changes run inside the caller's transaction, next to the ledger posting they belong
// to (Stage 13 transfers, Stage 14 payments). The ledger (src/modules/ledger) moves the money;
// this module records what the operation is and where it stands.
import { ConflictError, NotFoundError } from '../../common/errors/index.ts';
import { encodeCursor } from '../../common/utils/cursor.ts';
import type {
  Prisma,
  PrismaClient,
  Transaction,
  TransactionStatus,
} from '../../generated/prisma/client.ts';
import type { HistoryQuery } from './transaction.schema.ts';
import {
  canTransactionTransition,
  generateReference,
  TRANSACTION_SHAPES,
  TransactionInvariantError,
  toTransactionView,
  type NewTransaction,
  type TransactionView,
  type TransactionWithParties,
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

// ─── Reading (the signed-in user's history) ──────────────────────────────────────────────

/** Incoming money from another user is listed once it actually arrived. */
const VISIBLE_INCOMING_P2P: readonly TransactionStatus[] = ['COMPLETED', 'REVERSED'];

const PARTY = {
  select: { id: true, user: { select: { firstName: true, lastName: true, handle: true } } },
} as const;
const WITH_PARTIES = {
  sourceWallet: PARTY,
  destinationWallet: PARTY,
  reversalOf: { select: { id: true, reference: true } },
} as const satisfies Prisma.TransactionInclude;

/** What the user may see: everything leaving their wallets; arrivals per the rule above. */
function visibleTo(walletIds: readonly string[]): {
  outgoing: Prisma.TransactionWhereInput;
  incoming: Prisma.TransactionWhereInput;
} {
  return {
    outgoing: { sourceWalletId: { in: [...walletIds] } },
    incoming: {
      destinationWalletId: { in: [...walletIds] },
      OR: [{ sourceWalletId: null }, { status: { in: [...VISIBLE_INCOMING_P2P] } }],
    },
  };
}

export interface HistoryPage {
  transactions: TransactionView[];
  nextCursor: string | null;
}

export class TransactionService {
  readonly #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  /**
   * The user's transactions across their wallets, newest first, keyset-paginated on
   * (created_at, id). Visibility: everything leaving their wallets, their own deposits and
   * refunds at any status, and money from another user only once it arrived (a failed
   * transfer to them is the sender's business, reason included).
   */
  async list(userId: string, query: HistoryQuery): Promise<HistoryPage> {
    const mine = await this.#myWallets(userId, query.walletId);
    const { outgoing, incoming } = visibleTo([...mine.keys()]);
    const sides =
      query.direction === 'out'
        ? [outgoing]
        : query.direction === 'in'
          ? [incoming]
          : [outgoing, incoming];

    const filters: Prisma.TransactionWhereInput[] = [{ OR: sides }];
    if (query.type !== undefined) filters.push({ type: query.type });
    if (query.status !== undefined) filters.push({ status: query.status });
    if (query.from !== undefined) filters.push({ createdAt: { gte: query.from } });
    if (query.to !== undefined) filters.push({ createdAt: { lt: query.to } });
    if (query.cursor !== undefined) {
      const { createdAt, id } = query.cursor;
      // Strictly after the cursor in (created_at DESC, id DESC) order: equal timestamps are
      // split by id, so a page boundary inside a same-millisecond run skips and repeats nothing.
      filters.push({ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] });
    }

    const rows = await this.#db.transaction.findMany({
      where: { AND: filters },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: WITH_PARTIES,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      transactions: await this.#views(page, mine),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /** One of the user's transactions, under the same visibility rule; otherwise a 404. */
  async get(userId: string, transactionId: string): Promise<TransactionView> {
    const mine = await this.#myWallets(userId);
    const { outgoing, incoming } = visibleTo([...mine.keys()]);
    const row = await this.#db.transaction.findFirst({
      where: { id: transactionId, OR: [outgoing, incoming] },
      include: WITH_PARTIES,
    });
    if (row === null) throw new NotFoundError('Transaction not found.');
    const [view] = await this.#views([row], mine);
    if (view === undefined) throw new NotFoundError('Transaction not found.');
    return view;
  }

  /** The user's wallets (id → ledger account). A walletId filter must be one of theirs. */
  async #myWallets(userId: string, walletId?: string): Promise<Map<string, string>> {
    const wallets = await this.#db.wallet.findMany({
      where: { userId, ...(walletId === undefined ? {} : { id: walletId }) },
      select: { id: true, ledgerAccountId: true },
    });
    if (walletId !== undefined && wallets.length === 0) {
      throw new NotFoundError('Wallet not found.');
    }
    return new Map(wallets.map((w) => [w.id, w.ledgerAccountId]));
  }

  /** Views with the caller's balance after each posting (from their own ledger entry). */
  async #views(
    rows: TransactionWithParties[],
    mine: Map<string, string>,
  ): Promise<TransactionView[]> {
    const entries =
      rows.length === 0
        ? []
        : await this.#db.ledgerEntry.findMany({
            where: {
              transactionId: { in: rows.map((r) => r.id) },
              ledgerAccountId: { in: [...mine.values()] },
            },
            select: { transactionId: true, balanceAfter: true },
          });
    const after = new Map(entries.map((e) => [e.transactionId, e.balanceAfter]));
    const myIds = new Set(mine.keys());
    return rows.map((row) => toTransactionView(row, myIds, after.get(row.id) ?? null));
  }
}
