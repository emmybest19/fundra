// Reconciliation (docs/ARCHITECTURE.md §7.9): checks the cached wallet balances against the
// ledger they summarise, and the ledger's own invariants. It only reports: a mismatch is
// never "fixed" automatically, because the cache, the entries or the code could be the one
// that's wrong, and money must not be moved to make numbers agree. A person investigates.
import type { PrismaClient } from '../../generated/prisma/client.ts';

/** In flight longer than this deserves a look (an abandoned checkout, a stuck payout). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export interface WalletDrift {
  walletId: string;
  userId: string;
  /** What the wallet row says. */
  cachedLedgerBalance: string;
  cachedAvailableBalance: string;
  /** What the entries and active holds say it should be. */
  ledgerBalanceFromEntries: string;
  expectedAvailableBalance: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  ok: boolean;
  wallets: { checked: number; drifted: WalletDrift[] };
  ledger: { debits: string; credits: string; balanced: boolean };
  /** Things the code should make impossible; any count above zero is a bug to find. */
  invariants: { completedWithoutEntries: number; activeHoldsOnFinishedTransactions: number };
  /** Not wrong, but waiting on someone. */
  attention: {
    processingOverADay: Record<string, number>;
    paymentsHeldForReview: number;
    webhooksFailed: number;
  };
}

export class ReconciliationService {
  readonly #db: PrismaClient;
  readonly #now: () => number;

  constructor(db: PrismaClient, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * One consistent snapshot (REPEATABLE READ): every wallet, its entries and its holds are
   * read as of the same moment, so a posting in progress can't look like drift.
   */
  async run(): Promise<ReconciliationReport> {
    const now = this.#now();
    return this.#db.$transaction(
      async (tx) => {
        const wallets = await tx.$queryRaw<
          {
            id: string;
            user_id: string;
            ledger_balance: bigint;
            available_balance: bigint;
            from_entries: bigint;
            held: bigint;
          }[]
        >`
          SELECT w.id, w.user_id, w.ledger_balance, w.available_balance,
                 COALESCE(e.net, 0)::bigint AS from_entries,
                 COALESCE(h.held, 0)::bigint AS held
          FROM wallets w
          LEFT JOIN (
            SELECT ledger_account_id,
                   SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS net
            FROM ledger_entries GROUP BY ledger_account_id
          ) e ON e.ledger_account_id = w.ledger_account_id
          LEFT JOIN (
            SELECT wallet_id, SUM(amount) AS held FROM holds WHERE status = 'ACTIVE' GROUP BY wallet_id
          ) h ON h.wallet_id = w.id
          ORDER BY w.id`;
        const drifted: WalletDrift[] = wallets
          .filter(
            (w) =>
              w.ledger_balance !== w.from_entries ||
              w.available_balance !== w.from_entries - w.held,
          )
          .map((w) => ({
            walletId: w.id,
            userId: w.user_id,
            cachedLedgerBalance: w.ledger_balance.toString(),
            cachedAvailableBalance: w.available_balance.toString(),
            ledgerBalanceFromEntries: w.from_entries.toString(),
            expectedAvailableBalance: (w.from_entries - w.held).toString(),
          }));

        const [totals] = await tx.$queryRaw<{ debits: bigint; credits: bigint }[]>`
          SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::bigint AS debits,
                 COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::bigint AS credits
          FROM ledger_entries`;
        const debits = totals?.debits ?? 0n;
        const credits = totals?.credits ?? 0n;

        const [invariants] = await tx.$queryRaw<
          { completed_without_entries: bigint; holds_on_finished: bigint }[]
        >`
          SELECT
            (SELECT COUNT(*) FROM transactions t WHERE t.status IN ('COMPLETED', 'REVERSED')
               AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = t.id))::bigint
              AS completed_without_entries,
            (SELECT COUNT(*) FROM holds h JOIN transactions t ON t.id = h.transaction_id
               WHERE h.status = 'ACTIVE' AND t.status NOT IN ('PENDING', 'PROCESSING'))::bigint
              AS holds_on_finished`;

        const stale = await tx.transaction.groupBy({
          by: ['type'],
          where: { status: 'PROCESSING', createdAt: { lt: new Date(now - STALE_AFTER_MS) } },
          _count: { _all: true },
        });
        const [held] = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*)::bigint AS count FROM payments WHERE metadata ? 'review'`;
        const webhooksFailed = await tx.webhookEvent.count({ where: { status: 'FAILED' } });

        const completedWithoutEntries = Number(invariants?.completed_without_entries ?? 0n);
        const activeHoldsOnFinishedTransactions = Number(invariants?.holds_on_finished ?? 0n);
        return {
          checkedAt: new Date(now).toISOString(),
          ok:
            drifted.length === 0 &&
            debits === credits &&
            completedWithoutEntries === 0 &&
            activeHoldsOnFinishedTransactions === 0,
          wallets: { checked: wallets.length, drifted },
          ledger: {
            debits: debits.toString(),
            credits: credits.toString(),
            balanced: debits === credits,
          },
          invariants: { completedWithoutEntries, activeHoldsOnFinishedTransactions },
          attention: {
            processingOverADay: Object.fromEntries(stale.map((s) => [s.type, s._count._all])),
            paymentsHeldForReview: Number(held?.count ?? 0n),
            webhooksFailed,
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
