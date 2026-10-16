// Admin use cases: users, KYC review queue, transaction investigation, wallets, webhooks and
// the audit trail (docs/ARCHITECTURE.md §6.5). Permissions are enforced by the router; this
// layer enforces separation of duties (nobody acts on their own account) and state rules.
// Money and KYC decisions reuse the services that own them, so admins follow the same rules.
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/index.ts';
import { encodeCursor, type CursorPosition } from '../../common/utils/cursor.ts';
import { hasPermissions, isRoleName } from '../../common/constants/rbac.ts';
import type {
  Prisma,
  PrismaClient,
  TransactionStatus,
  TransactionType,
  UserStatus,
  WebhookStatus,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import { maskAccountNumber } from '../payments/outbound-payment.service.ts';
import { changeWalletStatus } from '../wallets/wallet.service.ts';

const REASON_MAX = 500;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Newest first by (created_at, id): the keyset condition after a cursor. */
function after(
  cursor: CursorPosition | undefined,
  field: 'createdAt' | 'receivedAt' = 'createdAt',
) {
  if (cursor === undefined) return {};
  return {
    OR: [
      { [field]: { lt: cursor.createdAt } },
      { [field]: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function page<T extends { id: string }>(
  rows: T[],
  limit: number,
  at: (row: T) => Date,
): { rows: T[]; nextCursor: string | null } {
  const slice = rows.slice(0, limit);
  const last = slice.at(-1);
  return {
    rows: slice,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ createdAt: at(last), id: last.id })
        : null,
  };
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > REASON_MAX) {
    throw new ValidationError([
      { path: 'reason', message: `Give a reason of 1–${String(REASON_MAX)} characters` },
    ]);
  }
  return trimmed;
}

const selfAction = () =>
  new ForbiddenError("You can't take this action on your own account.", {
    code: ErrorCode.ADMIN_SELF_ACTION,
  });

// ─── Views ───────────────────────────────────────────────────────────────────────────────

const USER_SUMMARY = {
  id: true,
  email: true,
  phone: true,
  handle: true,
  firstName: true,
  lastName: true,
  status: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  roles: { select: { role: { select: { name: true } } } },
  kycProfile: { select: { tier: true, status: true } },
} as const satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SUMMARY }>;

export interface AdminUserView {
  id: string;
  email: string;
  phone: string;
  handle: string;
  name: string;
  status: UserStatus;
  roles: string[];
  emailVerified: boolean;
  phoneVerified: boolean;
  kyc: { tier: number; status: string } | null;
  createdAt: string;
}

function userView(row: UserRow): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    handle: row.handle,
    name: `${row.firstName} ${row.lastName}`,
    status: row.status,
    roles: row.roles.map((r) => r.role.name),
    emailVerified: row.emailVerifiedAt !== null,
    phoneVerified: row.phoneVerifiedAt !== null,
    kyc:
      row.kycProfile === null ? null : { tier: row.kycProfile.tier, status: row.kycProfile.status },
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AdminWalletView {
  id: string;
  userId: string;
  accountNumber: string;
  currency: string;
  status: string;
  ledgerBalance: string;
  availableBalance: string;
  createdAt: string;
}

function walletView(row: Prisma.WalletGetPayload<object>): AdminWalletView {
  return {
    id: row.id,
    userId: row.userId,
    accountNumber: row.accountNumber,
    currency: row.currency,
    status: row.status,
    ledgerBalance: row.ledgerBalance.toString(),
    availableBalance: row.availableBalance.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const PARTY = {
  select: { id: true, accountNumber: true, user: { select: { id: true, handle: true } } },
} as const;
const TX_INCLUDE = {
  sourceWallet: PARTY,
  destinationWallet: PARTY,
} as const satisfies Prisma.TransactionInclude;

type TxRow = Prisma.TransactionGetPayload<{ include: typeof TX_INCLUDE }>;

function party(wallet: TxRow['sourceWallet']) {
  return wallet === null
    ? null
    : {
        walletId: wallet.id,
        accountNumber: wallet.accountNumber,
        userId: wallet.user.id,
        handle: wallet.user.handle,
      };
}

function transactionView(row: TxRow) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    currency: row.currency,
    amount: row.amount.toString(),
    fee: row.fee.toString(),
    source: party(row.sourceWallet),
    destination: party(row.destinationWallet),
    description: row.description,
    failureReason: row.failureReason,
    reversalOfId: row.reversalOfId,
    initiatedByUserId: row.initiatedByUserId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────────────────

export interface ListQuery {
  limit: number;
  cursor?: CursorPosition | undefined;
}

export class AdminService {
  readonly #db: PrismaClient;
  readonly #now: () => number;

  constructor(db: PrismaClient, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  // ─── Users ─────────────────────────────────────────────────────────────────────────────

  /** Search by email, phone, handle or name (case-insensitive, contains), newest first. */
  async listUsers(
    query: ListQuery & { q?: string | undefined; status?: UserStatus | undefined },
  ): Promise<Page<AdminUserView>> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      AND: [
        query.status === undefined ? {} : { status: query.status },
        q === undefined || q === ''
          ? {}
          : {
              OR: [
                { email: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q } },
                { handle: { contains: q.replace(/^@/, '').toLowerCase() } },
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
              ],
            },
        after(query.cursor),
      ],
    };
    const rows = await this.#db.user.findMany({
      where,
      select: USER_SUMMARY,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const result = page(rows, query.limit, (r) => r.createdAt);
    return { items: result.rows.map(userView), nextCursor: result.nextCursor };
  }

  async getUser(userId: string) {
    const row = await this.#db.user.findUnique({ where: { id: userId }, select: USER_SUMMARY });
    if (row === null) throw new NotFoundError('User not found.');
    const wallets = await this.#db.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    const activeSessions = await this.#db.session.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date(this.#now()) } },
    });
    return { ...userView(row), wallets: wallets.map(walletView), activeSessions };
  }

  /**
   * Suspends an account: no sign-in, every session ended. Not your own; and an account that
   * holds a staff role only by someone who can assign roles (SUPER_ADMIN), so one admin can't
   * lock out another.
   */
  async suspendUser(
    targetId: string,
    admin: { userId: string; roles: readonly string[] },
    reason: string,
    context: AuditContext,
  ): Promise<AdminUserView> {
    const why = requireReason(reason);
    if (targetId === admin.userId) throw selfAction();
    await this.#db.$transaction(async (tx) => {
      const target = await this.#lockUser(tx, targetId);
      const staff = target.roles.map((r) => r.role.name).filter((name) => name !== 'USER');
      if (staff.length > 0 && !hasPermissions(admin.roles.filter(isRoleName), ['roles:assign'])) {
        throw new ForbiddenError('Only a super admin can suspend a staff account.', {
          code: ErrorCode.FORBIDDEN,
        });
      }
      if (target.status !== 'ACTIVE' && target.status !== 'PENDING_VERIFICATION') {
        throw new ConflictError(`This account is ${target.status}, so it can't be suspended.`, {
          code: ErrorCode.CONFLICT,
        });
      }
      await tx.user.update({ where: { id: targetId }, data: { status: 'SUSPENDED' } });
      const { count: sessionsRevoked } = await tx.session.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date(this.#now()), revokeReason: 'ADMIN' },
      });
      await recordAudit(tx, {
        action: 'user.suspended',
        actor: { type: 'ADMIN', userId: admin.userId },
        resource: { type: 'user', id: targetId },
        context,
        metadata: { reason: why, from: target.status, sessionsRevoked },
      });
    });
    return this.#userView(targetId);
  }

  /**
   * Lifts a suspension, or reopens a deactivated account (its CLOSED wallets reopen with it,
   * in the same transaction). The account comes back ACTIVE if both contacts are verified,
   * otherwise PENDING_VERIFICATION.
   */
  async reactivateUser(
    targetId: string,
    adminId: string,
    reason: string,
    context: AuditContext,
  ): Promise<AdminUserView> {
    const why = requireReason(reason);
    if (targetId === adminId) throw selfAction();
    await this.#db.$transaction(async (tx) => {
      const target = await this.#lockUser(tx, targetId);
      if (target.status !== 'SUSPENDED' && target.status !== 'DEACTIVATED') {
        throw new ConflictError(
          `This account is ${target.status}; there is nothing to reactivate.`,
          {
            code: ErrorCode.CONFLICT,
          },
        );
      }
      const to: UserStatus =
        target.emailVerifiedAt !== null && target.phoneVerifiedAt !== null
          ? 'ACTIVE'
          : 'PENDING_VERIFICATION';
      await tx.user.update({ where: { id: targetId }, data: { status: to } });

      let walletsReopened = 0;
      if (target.status === 'DEACTIVATED') {
        // User, then wallets: the same lock order as deactivation.
        const wallets = await tx.$queryRaw<
          { id: string; user_id: string; status: 'ACTIVE' | 'FROZEN' | 'CLOSED' }[]
        >`
          SELECT id, user_id, status FROM wallets WHERE user_id = ${targetId}::uuid ORDER BY id FOR UPDATE`;
        for (const wallet of wallets) {
          if (wallet.status !== 'CLOSED') continue;
          await changeWalletStatus(
            tx,
            { id: wallet.id, userId: wallet.user_id, status: wallet.status },
            'ACTIVE',
            {
              actor: { type: 'ADMIN', userId: adminId },
              context,
              notify: false,
            },
          );
          walletsReopened++;
        }
      }
      await recordAudit(tx, {
        action: 'user.reactivated',
        actor: { type: 'ADMIN', userId: adminId },
        resource: { type: 'user', id: targetId },
        context,
        metadata: { reason: why, from: target.status, to, walletsReopened },
      });
    });
    return this.#userView(targetId);
  }

  // ─── KYC queue ─────────────────────────────────────────────────────────────────────────

  /** Profiles waiting for a person (Tier 3: PENDING or IN_REVIEW), oldest first. */
  async kycQueue(status: 'PENDING' | 'IN_REVIEW' | undefined) {
    const rows = await this.#db.kycProfile.findMany({
      where: { status: status ?? { in: ['PENDING', 'IN_REVIEW'] } },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      include: { user: { select: { id: true, handle: true, firstName: true, lastName: true } } },
    });
    return rows.map((row) => ({
      profileId: row.id,
      user: {
        id: row.user.id,
        handle: row.user.handle,
        name: `${row.user.firstName} ${row.user.lastName}`,
      },
      tier: row.tier,
      status: row.status,
      reviewedByUserId: row.reviewedByUserId,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** 404 rather than a database error for an unknown profile. */
  async kycProfileOwner(profileId: string): Promise<string> {
    const row = await this.#db.kycProfile.findUnique({
      where: { id: profileId },
      select: { userId: true },
    });
    if (row === null) throw new NotFoundError('KYC profile not found.');
    return row.userId;
  }

  // ─── Transactions and wallets ──────────────────────────────────────────────────────────

  async listTransactions(
    query: ListQuery & {
      userId?: string | undefined;
      walletId?: string | undefined;
      reference?: string | undefined;
      type?: TransactionType | undefined;
      status?: TransactionStatus | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    },
  ) {
    const wallets =
      query.userId === undefined
        ? undefined
        : (
            await this.#db.wallet.findMany({
              where: { userId: query.userId },
              select: { id: true },
            })
          ).map((w) => w.id);
    const touching = (ids: string[]): Prisma.TransactionWhereInput => ({
      OR: [{ sourceWalletId: { in: ids } }, { destinationWalletId: { in: ids } }],
    });
    const rows = await this.#db.transaction.findMany({
      where: {
        AND: [
          wallets === undefined ? {} : touching(wallets),
          query.walletId === undefined ? {} : touching([query.walletId]),
          query.reference === undefined ? {} : { reference: query.reference },
          query.type === undefined ? {} : { type: query.type },
          query.status === undefined ? {} : { status: query.status },
          query.from === undefined ? {} : { createdAt: { gte: query.from } },
          query.to === undefined ? {} : { createdAt: { lt: query.to } },
          after(query.cursor),
        ],
      },
      include: TX_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const result = page(rows, query.limit, (r) => r.createdAt);
    return { items: result.rows.map(transactionView), nextCursor: result.nextCursor };
  }

  /** Everything about one transaction: entries, hold, provider details, reversal, webhooks. */
  async getTransaction(id: string) {
    const row = await this.#db.transaction.findUnique({
      where: { id },
      include: {
        ...TX_INCLUDE,
        entries: {
          include: { ledgerAccount: { select: { code: true } } },
          orderBy: { createdAt: 'asc' },
        },
        hold: true,
        payment: { include: { provider: { select: { code: true } } } },
        transfer: true,
        reversedBy: { select: { id: true, reference: true, status: true } },
        webhookEvents: {
          select: { id: true, eventId: true, eventType: true, status: true, receivedAt: true },
        },
      },
    });
    if (row === null) throw new NotFoundError('Transaction not found.');
    return {
      ...transactionView(row),
      entries: row.entries.map((e) => ({
        account: e.ledgerAccount.code,
        direction: e.direction,
        amount: e.amount.toString(),
      })),
      hold:
        row.hold === null
          ? null
          : {
              amount: row.hold.amount.toString(),
              status: row.hold.status,
              resolvedAt: row.hold.resolvedAt?.toISOString() ?? null,
            },
      payment:
        row.payment === null
          ? null
          : {
              provider: row.payment.provider.code,
              direction: row.payment.direction,
              providerReference: row.payment.providerReference,
              providerStatus: row.payment.providerStatus,
              bankCode: row.payment.bankCode,
              bankAccountNumber:
                row.payment.bankAccountNumber === null
                  ? null
                  : maskAccountNumber(row.payment.bankAccountNumber),
              bankAccountName: row.payment.bankAccountName,
              metadata: row.payment.metadata,
            },
      transfer:
        row.transfer === null
          ? null
          : {
              recipientLookup: row.transfer.recipientLookup,
              beneficiaryId: row.transfer.beneficiaryId,
            },
      reversal: row.reversedBy,
      webhookEvents: row.webhookEvents.map((w) => ({
        ...w,
        receivedAt: w.receivedAt.toISOString(),
      })),
    };
  }

  async getWallet(walletId: string): Promise<AdminWalletView> {
    const row = await this.#db.wallet.findUnique({ where: { id: walletId } });
    if (row === null) throw new NotFoundError('Wallet not found.');
    return walletView(row);
  }

  // ─── Webhooks and audit ────────────────────────────────────────────────────────────────

  async listWebhooks(query: ListQuery & { status?: WebhookStatus | undefined }) {
    const rows = await this.#db.webhookEvent.findMany({
      where: {
        AND: [
          query.status === undefined ? {} : { status: query.status },
          after(query.cursor, 'receivedAt'),
        ],
      },
      include: { provider: { select: { code: true } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const result = page(rows, query.limit, (r) => r.receivedAt);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        provider: row.provider.code,
        eventId: row.eventId,
        eventType: row.eventType,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        transactionId: row.transactionId,
        payload: row.payload,
        receivedAt: row.receivedAt.toISOString(),
        processedAt: row.processedAt?.toISOString() ?? null,
      })),
      nextCursor: result.nextCursor,
    };
  }

  async listAuditLogs(
    query: ListQuery & {
      actorUserId?: string | undefined;
      action?: string | undefined;
      resourceType?: string | undefined;
      resourceId?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    },
  ) {
    const rows = await this.#db.auditLog.findMany({
      where: {
        AND: [
          query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId },
          query.action === undefined ? {} : { action: query.action },
          query.resourceType === undefined ? {} : { resourceType: query.resourceType },
          query.resourceId === undefined ? {} : { resourceId: query.resourceId },
          query.from === undefined ? {} : { createdAt: { gte: query.from } },
          query.to === undefined ? {} : { createdAt: { lt: query.to } },
          after(query.cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const result = page(rows, query.limit, (r) => r.createdAt);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorType: row.actorType,
        actorUserId: row.actorUserId,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        requestId: row.requestId,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────────────

  async #lockUser(tx: Prisma.TransactionClient, userId: string) {
    const [locked] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    if (locked === undefined) throw new NotFoundError('User not found.');
    return tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
  }

  async #userView(userId: string): Promise<AdminUserView> {
    return userView(
      await this.#db.user.findUniqueOrThrow({ where: { id: userId }, select: USER_SUMMARY }),
    );
  }
}
