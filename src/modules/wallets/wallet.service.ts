// Business logic for wallets. Creation runs inside the caller's transaction: KYC approval
// (Stage 9) and the wallet commit together, so an approved user always has a wallet.
import type { Currency } from '../../common/constants/currency.ts';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import type {
  Prisma,
  PrismaClient,
  UserStatus,
  Wallet,
  WalletStatus,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditAction, AuditActor, AuditContext } from '../audit/audit.types.ts';
import { walletAccountCode } from '../ledger/ledger.utils.ts';
import { generateAccountNumber } from './account-number.ts';
import { assertWalletTransition } from './wallet-status.ts';
import { toWalletView, type WalletView } from './wallet.types.ts';

/** Fresh numbers to try before giving up: with 10⁹ possibilities, 5 clashes means a bug. */
const ACCOUNT_NUMBER_ATTEMPTS = 5;

/**
 * Creates the user's wallet in `currency`, with its own ledger account, unless one exists
 * (then it's returned unchanged). Balances start at 0: only the ledger ever changes them.
 *
 * The wallet ID comes from PostgreSQL first (`uuidv7()`), because the ledger account's code
 * contains it (`WALLET:<id>`). The unique (user_id, currency) index makes a second wallet
 * impossible even if two callers race; the unique account-number index is the backstop for
 * the (astronomically unlikely) case that two approvals pick the same free number at once.
 */
export async function createWallet(
  tx: Prisma.TransactionClient,
  input: { userId: string; currency: Currency; actor: AuditActor; context: AuditContext },
): Promise<Wallet> {
  const existing = await tx.wallet.findUnique({
    where: { userId_currency: { userId: input.userId, currency: input.currency } },
  });
  if (existing !== null) return existing;

  const accountNumber = await freeAccountNumber(tx);
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`;
  if (row === undefined) throw new Error('uuidv7() returned no row');

  const ledgerAccount = await tx.ledgerAccount.create({
    data: { code: walletAccountCode(row.id), type: 'LIABILITY', currency: input.currency },
  });
  const wallet = await tx.wallet.create({
    data: {
      id: row.id,
      userId: input.userId,
      currency: input.currency,
      accountNumber,
      ledgerAccountId: ledgerAccount.id,
    },
  });
  await recordAudit(tx, {
    action: 'wallet.created',
    actor: input.actor,
    resource: { type: 'wallet', id: wallet.id },
    context: input.context,
    // The wallet ID only: account numbers stay out of logs and audit records.
    metadata: { userId: input.userId, currency: input.currency, ledgerAccountId: ledgerAccount.id },
  });
  return wallet;
}

async function freeAccountNumber(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < ACCOUNT_NUMBER_ATTEMPTS; attempt++) {
    const candidate = generateAccountNumber();
    const taken = await tx.wallet.findUnique({
      where: { accountNumber: candidate },
      select: { id: true },
    });
    if (taken === null) return candidate;
  }
  throw new Error(`No free account number after ${String(ACCOUNT_NUMBER_ATTEMPTS)} attempts`);
}

function auditActionFor(from: WalletStatus, to: WalletStatus): AuditAction {
  switch (to) {
    case 'FROZEN':
      return 'wallet.frozen';
    case 'CLOSED':
      return 'wallet.closed';
    case 'ACTIVE':
      return from === 'CLOSED' ? 'wallet.reopened' : 'wallet.unfrozen';
  }
}

/**
 * Moves a wallet to `to` through the transition table, with an audit row and (if `notify`)
 * a `wallet.status_changed` event. **The caller must already hold the wallet's row lock**,
 * so the status it checked is the status it changes. A reason is recorded in the audit log
 * only: never in the event or the API (no tipping off).
 */
export async function changeWalletStatus(
  tx: Prisma.TransactionClient,
  wallet: Pick<Wallet, 'id' | 'userId' | 'status'>,
  to: WalletStatus,
  options: { actor: AuditActor; context: AuditContext; reason?: string; notify: boolean },
): Promise<void> {
  assertWalletTransition(wallet.status, to);
  await tx.wallet.update({ where: { id: wallet.id }, data: { status: to } });
  await recordAudit(tx, {
    action: auditActionFor(wallet.status, to),
    actor: options.actor,
    resource: { type: 'wallet', id: wallet.id },
    context: options.context,
    metadata: {
      userId: wallet.userId,
      from: wallet.status,
      to,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
  });
  if (options.notify) {
    await writeOutboxEvent(tx, {
      type: 'wallet.status_changed',
      aggregate: { type: 'wallet', id: wallet.id },
      payload: { userId: wallet.userId, walletId: wallet.id, status: to },
    });
  }
}

/** Accounts whose wallets may be reopened: reactivated ones (Stage 19 reactivates first). */
const REOPENABLE_USER_STATUSES: readonly UserStatus[] = ['ACTIVE', 'PENDING_VERIFICATION'];

export class WalletService {
  readonly #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  async list(userId: string): Promise<WalletView[]> {
    const wallets = await this.#db.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return wallets.map(toWalletView);
  }

  /**
   * One of the user's own wallets. Another user's wallet is a 404, exactly like a wallet
   * that doesn't exist, so wallet IDs can't be used to probe (IDOR).
   */
  async get(userId: string, walletId: string): Promise<WalletView> {
    const wallet = await this.#db.wallet.findFirst({ where: { id: walletId, userId } });
    if (wallet === null) throw new NotFoundError('Wallet not found.');
    return toWalletView(wallet);
  }

  // ─── Admin actions (service only; endpoints arrive in Stage 19) ─────────────────────────

  /** Compliance or fraud hold: no money in or out (Stage 11 enforces it). Reason audited. */
  async freeze(
    walletId: string,
    adminId: string,
    reason: string,
    context: AuditContext,
  ): Promise<WalletView> {
    return this.#adminChange(walletId, adminId, 'FROZEN', context, requireReason(reason));
  }

  async unfreeze(
    walletId: string,
    adminId: string,
    reason: string,
    context: AuditContext,
  ): Promise<WalletView> {
    return this.#adminChange(walletId, adminId, 'ACTIVE', context, requireReason(reason));
  }

  /** Reopens a CLOSED wallet once its account has been reactivated (Stage 19). */
  async reopen(walletId: string, adminId: string, context: AuditContext): Promise<WalletView> {
    return this.#adminChange(walletId, adminId, 'ACTIVE', context, undefined, true);
  }

  async #adminChange(
    walletId: string,
    adminId: string,
    to: WalletStatus,
    context: AuditContext,
    reason: string | undefined,
    reopening = false,
  ): Promise<WalletView> {
    return this.#db.$transaction(async (tx) => {
      // Same lock order as deactivation (user, then wallet), so the two can't deadlock.
      const [owner] = await tx.$queryRaw<{ status: UserStatus }[]>`
        SELECT u.status FROM users u JOIN wallets w ON w.user_id = u.id
        WHERE w.id = ${walletId}::uuid FOR SHARE OF u`;
      if (owner === undefined) throw new NotFoundError('Wallet not found.');
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE`;
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });

      // Separation of duties: nobody changes their own wallet's status, whatever their role.
      if (wallet.userId === adminId) {
        throw new ForbiddenError("You can't change the status of your own wallet.", {
          code: ErrorCode.WALLET_SELF_ACTION,
        });
      }
      // reopen() is the only way out of CLOSED, and it does nothing else.
      if (reopening !== (wallet.status === 'CLOSED')) {
        throw new ConflictError(
          reopening
            ? `Only a CLOSED wallet can be reopened; this one is ${wallet.status}.`
            : 'A CLOSED wallet can only be reopened, after its account is reactivated.',
        );
      }
      if (reopening && !REOPENABLE_USER_STATUSES.includes(owner.status)) {
        throw new ConflictError('Reactivate the account before reopening its wallet.');
      }

      await changeWalletStatus(tx, wallet, to, {
        actor: { type: 'ADMIN', userId: adminId },
        context,
        ...(reason === undefined ? {} : { reason }),
        notify: true,
      });
      return toWalletView(await tx.wallet.findUniqueOrThrow({ where: { id: walletId } }));
    });
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new ValidationError([{ path: 'reason', message: 'Give a reason of 1–500 characters' }]);
  }
  return trimmed;
}
