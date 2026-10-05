// Business logic for users: profile, preferences, contact changes, deactivation.
import { ConflictError, ErrorCode, ValidationError } from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import { maskEmail, maskPhone } from '../../common/utils/mask.ts';
import type {
  KycStatus,
  Prisma,
  PrismaClient,
  User,
  UserStatus,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import type { IssuedTokens } from '../auth/auth.service.ts';
import type { OtpService } from '../auth/otp.ts';
import { failClosed, invalidOtp, otpCooldown } from '../auth/verification.service.ts';
import type { MessageSender } from '../notifications/notification.types.ts';
import {
  mergePreferences,
  readPreferences,
  type PreferencesPatch,
  type UserPreferences,
} from './preferences.ts';
import { assertStatusTransition, statusAfterVerification } from './user-status.ts';
import { email, phone, type UpdateProfileInput } from './user.schema.ts';
import { PROFILE_INCLUDE, toUserProfile, type UserProfile } from './user.types.ts';

/**
 * Finds a user by email (if the identifier contains @) or phone, in any accepted format.
 * Unparseable input finds nobody rather than erroring, so callers can't distinguish
 * "malformed" from "unknown" for an attacker.
 */
export async function findUserByIdentifier(
  db: Pick<PrismaClient, 'user'>,
  identifier: string,
): Promise<User | null> {
  if (identifier.includes('@')) {
    const parsed = email.safeParse(identifier);
    return parsed.success ? db.user.findUnique({ where: { email: parsed.data } }) : null;
  }
  const parsed = phone.safeParse(identifier);
  return parsed.success ? db.user.findUnique({ where: { phone: parsed.data } }) : null;
}

export const isDisabled = (user: Pick<User, 'status'>): boolean =>
  user.status === 'SUSPENDED' || user.status === 'DEACTIVATED';

export interface NewUser {
  email: string;
  phone: string;
  handle: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
}

/**
 * Creates a customer: the user (PENDING_VERIFICATION until email/phone are verified), an
 * empty KYC profile (tier 0: no wallet yet) and the USER role. Runs in the caller's
 * transaction so registration never leaves a half-created account.
 */
export async function createUser(tx: Prisma.TransactionClient, input: NewUser): Promise<User> {
  const user = await tx.user.create({ data: input });
  await tx.kycProfile.create({ data: { userId: user.id } });
  // Seeded by prisma/seed.ts; a missing role is a deployment error, not a user error.
  const role = await tx.role.findUniqueOrThrow({ where: { name: 'USER' } });
  await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

/** Re-authentication, provided by AuthService.confirmPassword (shares the login lockout). */
export interface PasswordConfirmer {
  confirmPassword(userId: string, password: string, context: AuditContext): Promise<User>;
}

/** Provided by AuthService.changePassword: it owns sessions and tokens. */
export interface PasswordChanger {
  changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
    context: AuditContext,
  ): Promise<IssuedTokens>;
}

export type ContactChannel = 'email' | 'phone';

const CONTACT = {
  email: {
    purpose: 'email_change',
    field: 'newEmail',
    messageChannel: 'EMAIL',
    action: 'user.email_changed',
    mask: maskEmail,
  },
  phone: {
    purpose: 'phone_change',
    field: 'newPhone',
    messageChannel: 'SMS',
    action: 'user.phone_changed',
    mask: maskPhone,
  },
} as const;

/**
 * The legal name locks from the first KYC approval (it's what KYC verified) and while a
 * submission is under review. Judged by `tier`, not only `status`: a user approved at Tier 1
 * and then rejected at Tier 2 has status REJECTED but a verified name.
 */
export function isNameLocked(kyc: { tier: number; status: KycStatus }): boolean {
  return kyc.tier > 0 || kyc.status === 'PENDING' || kyc.status === 'IN_REVIEW';
}

/** Money still moving: deactivating now would strand it. */
const OPEN_TRANSACTION_STATUSES = ['PENDING', 'PROCESSING'] as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

const contactOf = (user: User, channel: ContactChannel) =>
  channel === 'email' ? user.email : user.phone;

const contactWhere = (channel: ContactChannel, value: string) =>
  channel === 'email' ? { email: value } : { phone: value };

export class UserService {
  readonly #db: PrismaClient;
  readonly #passwords: PasswordConfirmer;
  readonly #otp: OtpService;
  readonly #sender: MessageSender;
  readonly #now: () => number;

  constructor(
    db: PrismaClient,
    passwords: PasswordConfirmer,
    otp: OtpService,
    sender: MessageSender,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#passwords = passwords;
    this.#otp = otp;
    this.#sender = sender;
    this.#now = now;
  }

  async getProfile(userId: string): Promise<UserProfile> {
    return toUserProfile(
      await this.#db.user.findUniqueOrThrow({ where: { id: userId }, include: PROFILE_INCLUDE }),
    );
  }

  /**
   * Updates name and/or handle. Only fields that actually change are written and audited.
   * Names lock once KYC is submitted (they're what KYC verifies, and what senders see when
   * confirming a recipient); a taken handle is HANDLE_TAKEN (handles are public anyway).
   */
  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
    context: AuditContext,
  ): Promise<UserProfile> {
    try {
      return await this.#db.$transaction(async (tx) => {
        const before = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const changes: { firstName?: string; lastName?: string; handle?: string } = {};
        for (const field of ['firstName', 'lastName', 'handle'] as const) {
          const value = input[field];
          if (value !== undefined && value !== before[field]) changes[field] = value;
        }

        if (changes.firstName !== undefined || changes.lastName !== undefined) {
          // FOR SHARE: a concurrent KYC submission (which updates this row) waits for us,
          // and if it committed first we see its status. No name change slips past a submit.
          const [kyc] = await tx.$queryRaw<{ status: KycStatus; tier: number }[]>`
            SELECT status, tier FROM kyc_profiles WHERE user_id = ${userId}::uuid FOR SHARE`;
          if (kyc !== undefined && isNameLocked(kyc)) {
            throw new ConflictError(
              'Your name is part of your identity verification and can no longer be changed here. Contact support to correct it.',
              { code: ErrorCode.NAME_LOCKED },
            );
          }
        }

        if (Object.keys(changes).length > 0) {
          await tx.user.update({ where: { id: userId }, data: changes });
          await recordAudit(tx, {
            action: 'user.profile_updated',
            actor: { type: 'USER', userId },
            resource: { type: 'user', id: userId },
            context,
            // Names are personal data: record which changed, not the values. Handles are public.
            metadata: {
              changed: Object.keys(changes),
              ...(changes.handle === undefined
                ? {}
                : { handle: { from: before.handle, to: changes.handle } }),
            },
          });
        }

        return toUserProfile(
          await tx.user.findUniqueOrThrow({ where: { id: userId }, include: PROFILE_INCLUDE }),
        );
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictError('That handle is already taken.', {
        code: ErrorCode.HANDLE_TAKEN,
        cause: err,
      });
    }
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    const { preferences } = await this.#db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { preferences: true },
    });
    return readPreferences(preferences);
  }

  /** Merges a partial update into the stored preferences and returns the full result. */
  async updatePreferences(
    userId: string,
    patch: PreferencesPatch,
    context: AuditContext,
  ): Promise<UserPreferences> {
    return this.#db.$transaction(async (tx) => {
      // Row lock: concurrent updates merge onto each other's result instead of one
      // read-modify-write silently overwriting the other.
      const [row] = await tx.$queryRaw<{ preferences: unknown }[]>`
        SELECT preferences FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (row === undefined) throw new Error(`User ${userId} not found`);
      const next = mergePreferences(readPreferences(row.preferences), patch);
      await tx.user.update({ where: { id: userId }, data: { preferences: next } });
      await recordAudit(tx, {
        action: 'user.preferences_updated',
        actor: { type: 'USER', userId },
        resource: { type: 'user', id: userId },
        context,
        metadata: { changes: patch },
      });
      return next;
    });
  }

  /**
   * Step 1 of changing email or phone: re-authenticate, then send a code to the **new**
   * address, bound to it. The current address stays in use until step 2 proves the user
   * controls the new one.
   *
   * An address held by another account gets the same 202 (and the same cooldown) but no code,
   * so this can't be used to find out who has an account.
   */
  async requestContactChange(
    userId: string,
    channel: ContactChannel,
    newValue: string,
    password: string,
    context: AuditContext,
  ): Promise<void> {
    const spec = CONTACT[channel];
    const user = await this.#passwords.confirmPassword(userId, password, context);
    if (contactOf(user, channel) === newValue) {
      throw new ValidationError([
        { path: `body.${spec.field}`, message: `That is already your ${channel}` },
      ]);
    }

    // Issued even when the address is taken, so the cooldown behaves identically.
    const issued = await failClosed(() => this.#otp.issue(spec.purpose, userId, newValue));
    if (issued === null) throw otpCooldown();

    await recordAudit(this.#db, {
      action: 'user.contact_change_requested',
      actor: { type: 'USER', userId },
      resource: { type: 'user', id: userId },
      context,
      metadata: { changed: channel, to: spec.mask(newValue) },
    });

    if ((await this.#db.user.count({ where: contactWhere(channel, newValue) })) > 0) return;

    await failClosed(() =>
      this.#sender.send({
        channel: spec.messageChannel,
        to: newValue,
        template: 'otp',
        data: { code: issued.code, purpose: spec.purpose },
      }),
    );
  }

  /**
   * Step 2: the code proves control of the new address, so it's saved as already verified.
   * That can complete verification (PENDING_VERIFICATION → ACTIVE). The **old** address is
   * alerted afterwards, so a takeover can't silently move the account's recovery channel.
   */
  async confirmContactChange(
    userId: string,
    channel: ContactChannel,
    newValue: string,
    code: string,
    context: AuditContext,
  ): Promise<UserProfile> {
    const spec = CONTACT[channel];
    const result = await failClosed(() => this.#otp.check(spec.purpose, userId, code, newValue));
    if (result !== 'ok') throw invalidOtp();

    const now = new Date(this.#now());
    let outcome: { profile: UserProfile; previous: string };
    try {
      outcome = await this.#db.$transaction(async (tx) => {
        const before = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const changed = await tx.user.update({
          where: { id: userId },
          data:
            channel === 'email'
              ? { email: newValue, emailVerifiedAt: now }
              : { phone: newValue, phoneVerifiedAt: now },
        });
        const status = statusAfterVerification(changed);
        if (status !== changed.status) {
          assertStatusTransition(changed.status, status);
          await tx.user.update({ where: { id: userId }, data: { status } });
        }
        await recordAudit(tx, {
          action: spec.action,
          actor: { type: 'USER', userId },
          resource: { type: 'user', id: userId },
          context,
          metadata: {
            from: spec.mask(contactOf(before, channel)),
            to: spec.mask(newValue),
            activated: status !== changed.status,
          },
        });
        await writeOutboxEvent(tx, {
          type: 'user.contact_changed',
          aggregate: { type: 'user', id: userId },
          payload: { userId, changed: channel },
        });
        return {
          previous: contactOf(before, channel),
          profile: toUserProfile(
            await tx.user.findUniqueOrThrow({ where: { id: userId }, include: PROFILE_INCLUDE }),
          ),
        };
      });
    } catch (err) {
      // Another account took the address between request and confirm.
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictError(`That ${channel} can't be used. Try a different one.`, {
        code: ErrorCode.CONTACT_UNAVAILABLE,
        cause: err,
      });
    }

    // Security alert to the old address. Best effort: the change has already happened.
    await this.#sender
      .send({
        channel: spec.messageChannel,
        to: outcome.previous,
        template: 'contact_changed',
        data: { changed: channel },
      })
      .catch(() => undefined);
    return outcome.profile;
  }

  /**
   * Self-service deactivation. Requires the password, a zero balance in every wallet and no
   * money in flight. Closes the wallets (no further money in or out), signs out every session,
   * and keeps all records: users are never deleted, and the email, phone and handle stay
   * reserved. Reactivation is a support action (Stage 19).
   *
   * Locks the user row, then the wallets (in id order). Money movement (Stage 11) locks
   * wallets and must reject CLOSED ones, so nothing can land between the balance check and
   * the close.
   */
  async deactivate(
    userId: string,
    password: string,
    reason: string | undefined,
    context: AuditContext,
  ): Promise<void> {
    await this.#passwords.confirmPassword(userId, password, context);
    const now = new Date(this.#now());

    const email = await this.#db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: UserStatus; email: string }[]>`
        SELECT status, email FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (locked === undefined) throw new Error(`User ${userId} not found`);
      assertStatusTransition(locked.status, 'DEACTIVATED');

      const wallets = await tx.$queryRaw<{ id: string; ledger_balance: bigint }[]>`
        SELECT id, ledger_balance FROM wallets WHERE user_id = ${userId}::uuid
        ORDER BY id FOR UPDATE`;
      if (wallets.some((wallet) => String(wallet.ledger_balance) !== '0')) {
        throw new ConflictError(
          'Withdraw or transfer your remaining balance before closing your account.',
          { code: ErrorCode.ACCOUNT_HAS_BALANCE },
        );
      }

      const open = await tx.transaction.count({
        where: {
          status: { in: [...OPEN_TRANSACTION_STATUSES] },
          OR: [
            { initiatedByUserId: userId },
            { sourceWallet: { userId } },
            { destinationWallet: { userId } },
          ],
        },
      });
      if (open > 0) {
        throw new ConflictError(
          'You have transactions still in progress. Try again once they have completed.',
          { code: ErrorCode.ACCOUNT_HAS_PENDING_TRANSACTIONS },
        );
      }

      await tx.user.update({
        where: { id: userId },
        data: { status: 'DEACTIVATED', deactivatedAt: now },
      });
      const { count: walletsClosed } = await tx.wallet.updateMany({
        where: { userId, status: { not: 'CLOSED' } },
        data: { status: 'CLOSED' },
      });
      const { count: sessionsRevoked } = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'ACCOUNT_DEACTIVATED' },
      });
      await recordAudit(tx, {
        action: 'user.deactivated',
        actor: { type: 'USER', userId },
        resource: { type: 'user', id: userId },
        context,
        metadata: { reason: reason ?? null, walletsClosed, sessionsRevoked },
      });
      await writeOutboxEvent(tx, {
        type: 'user.deactivated',
        aggregate: { type: 'user', id: userId },
        payload: { userId, walletsClosed },
      });
      return locked.email;
    });

    // Confirmation. Best effort: the account is already closed.
    await this.#sender
      .send({ channel: 'EMAIL', to: email, template: 'account_deactivated', data: {} })
      .catch(() => undefined);
  }
}
