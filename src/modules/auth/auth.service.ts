// Business logic for auth: registration, credentials, sessions and tokens.
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  isUniqueViolation,
  UnauthorizedError,
  ValidationError,
} from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import type { PrismaClient, Session, User } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import type { MessageSender } from '../notifications/notification.types.ts';
import { createUser, findUserByIdentifier, isDisabled } from '../users/user.service.ts';
import type { LoginInput, RegisterInput } from './auth.schema.ts';
import {
  hashPassword,
  needsRehash,
  passwordIsNotPersonal,
  verifyAgainstDummy,
  verifyPassword,
} from './password.ts';
import {
  generateRefreshToken,
  hashRefreshToken,
  SESSION_TTL_MS,
  type TokenService,
} from './tokens.ts';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1_000;

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/** Same error for "no such account" and "wrong password": nothing to enumerate. */
const invalidCredentials = () =>
  new UnauthorizedError('The email/phone or password is incorrect.', {
    code: ErrorCode.INVALID_CREDENTIALS,
  });

const incorrectPassword = () =>
  new ForbiddenError('The password is incorrect.', { code: ErrorCode.INCORRECT_PASSWORD });

/** One error for unknown, expired and revoked refresh tokens: nothing to probe. */
const invalidRefreshToken = () =>
  new UnauthorizedError('The session has expired. Please sign in again.', {
    code: ErrorCode.INVALID_REFRESH_TOKEN,
  });

const refreshTokenReused = () =>
  new UnauthorizedError('This sign-in session was ended for your security. Please sign in again.', {
    code: ErrorCode.REFRESH_TOKEN_REUSED,
  });

const accountDisabled = () =>
  new ForbiddenError('This account is not active. Contact support.', {
    code: ErrorCode.ACCOUNT_DISABLED,
  });

/** Thrown inside a transaction to roll it back when a concurrent refresh used the token first. */
class RefreshRaceLost extends Error {}

export class AuthService {
  readonly #db: PrismaClient;
  readonly #tokens: TokenService;
  readonly #sender: MessageSender;
  readonly #now: () => number;

  constructor(
    db: PrismaClient,
    tokens: TokenService,
    sender: MessageSender,
    now: () => number = Date.now,
  ) {
    this.#db = db;
    this.#tokens = tokens;
    this.#sender = sender;
    this.#now = now;
  }

  /**
   * Verifies credentials (lockout, timing-safe), then opens a session with its first refresh
   * token, an audit row and an `auth.login_succeeded` outbox event in one transaction.
   */
  async login(
    input: LoginInput,
    context: AuditContext,
  ): Promise<{ user: User; tokens: IssuedTokens }> {
    const user = await this.verifyCredentials(input.identifier, input.password, context);
    const now = this.#now();
    const expiresAt = new Date(now + SESSION_TTL_MS);
    const refresh = generateRefreshToken();
    // Device tracking: a device we haven't seen for this user (or an unidentified one) is new.
    const newDevice =
      input.deviceId === undefined ||
      (await this.#db.session.count({ where: { userId: user.id, deviceId: input.deviceId } })) ===
        0;

    const session = await this.#db.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          userId: user.id,
          deviceId: input.deviceId ?? null,
          deviceName: input.deviceName ?? null,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ip ?? null,
          lastUsedAt: new Date(now),
          expiresAt,
        },
      });
      await tx.refreshToken.create({
        data: { sessionId: created.id, tokenHash: refresh.hash, expiresAt },
      });
      await recordAudit(tx, {
        action: 'auth.login_succeeded',
        actor: { type: 'USER', userId: user.id },
        resource: { type: 'session', id: created.id },
        context,
        metadata: { deviceName: input.deviceName },
      });
      await writeOutboxEvent(tx, {
        type: 'auth.login_succeeded',
        aggregate: { type: 'user', id: user.id },
        payload: { userId: user.id, sessionId: created.id, newDevice },
      });
      return created;
    });

    return { user, tokens: await this.#issue(user.id, session, refresh.token) };
  }

  /**
   * Rotates a refresh token: the presented token is consumed and a new one is issued in the
   * same session. A token that was already consumed is evidence of theft (the thief or the
   * user is replaying it), so the whole session is revoked and both are signed out.
   */
  async refresh(refreshToken: string, context: AuditContext): Promise<IssuedTokens> {
    const record = await this.#db.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { session: { include: { user: true } } },
    });
    if (record === null) throw invalidRefreshToken();
    const { session } = record;

    if (record.usedAt !== null) {
      await this.#revokeForReuse(session, context);
      throw refreshTokenReused();
    }

    const now = this.#now();
    if (
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now ||
      record.expiresAt.getTime() <= now
    ) {
      throw invalidRefreshToken();
    }

    if (isDisabled(session.user)) {
      await this.#revokeSession(session.id, 'ACCOUNT_DISABLED');
      throw accountDisabled();
    }

    const next = generateRefreshToken();
    try {
      await this.#db.$transaction(async (tx) => {
        // Compare-and-swap: of two concurrent refreshes with one token, exactly one wins.
        // The loser blocks on the row lock, then sees used_at set and updates nothing.
        const { count } = await tx.refreshToken.updateMany({
          where: { id: record.id, usedAt: null },
          data: { usedAt: new Date(now) },
        });
        if (count === 0) throw new RefreshRaceLost();
        const created = await tx.refreshToken.create({
          data: { sessionId: session.id, tokenHash: next.hash, expiresAt: session.expiresAt },
        });
        await tx.refreshToken.update({
          where: { id: record.id },
          data: { replacedById: created.id },
        });
        await tx.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date(now) } });
      });
    } catch (err) {
      if (!(err instanceof RefreshRaceLost)) throw err;
      await this.#revokeForReuse(session, context);
      throw refreshTokenReused();
    }

    return this.#issue(session.userId, session, next.token);
  }

  /**
   * Ends the session that owns the refresh token. Always succeeds from the caller's point of
   * view, so logout can't be used to test whether a token is valid.
   */
  async logout(refreshToken: string, context: AuditContext): Promise<void> {
    const record = await this.#db.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { session: true },
    });
    // Unknown token, or session already ended: nothing to do (and nothing to reveal).
    if (record?.session.revokedAt !== null) return;

    if (record.usedAt !== null) {
      // A consumed token is a theft signal even at logout.
      await this.#revokeForReuse(record.session, context);
      return;
    }

    await this.#db.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: record.sessionId, revokedAt: null },
        data: { revokedAt: new Date(this.#now()), revokeReason: 'LOGOUT' },
      });
      if (count === 1) {
        await recordAudit(tx, {
          action: 'auth.logout',
          actor: { type: 'USER', userId: record.session.userId },
          resource: { type: 'session', id: record.sessionId },
          context,
        });
      }
    });
  }

  /**
   * Changes the password of a signed-in user (Stage 8). Re-checks the current password
   * (shares the login lockout), applies the new-password rules, then in one transaction:
   * saves the new hash, ends **every** session including this one, and opens a fresh session
   * for this device. Every token issued before the change stops working at once, on every
   * device; this device carries on with the tokens returned here. Audited, with an outbox
   * event and an alert email.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
    context: AuditContext,
  ): Promise<IssuedTokens> {
    const user = await this.confirmPassword(userId, currentPassword, context);
    if (!passwordIsNotPersonal(newPassword, user)) {
      throw new ValidationError([
        { path: 'body.newPassword', message: 'Must not contain your handle or email name' },
      ]);
    }
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw new ValidationError([
        { path: 'body.newPassword', message: 'Must be different from your current password' },
      ]);
    }

    // Hash outside the transaction: ~50 ms of CPU shouldn't hold a database connection.
    const passwordHash = await hashPassword(newPassword);
    const current = await this.#db.session.findUniqueOrThrow({ where: { id: currentSessionId } });
    const now = this.#now();
    const refresh = generateRefreshToken();
    const expiresAt = new Date(now + SESSION_TTL_MS);

    const session = await this.#db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: new Date(now) },
      });
      const { count } = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(now), revokeReason: 'PASSWORD_CHANGED' },
      });
      const created = await tx.session.create({
        data: {
          userId,
          deviceId: current.deviceId,
          deviceName: current.deviceName,
          userAgent: context.userAgent ?? current.userAgent,
          ipAddress: context.ip ?? null,
          lastUsedAt: new Date(now),
          expiresAt,
        },
      });
      await tx.refreshToken.create({
        data: { sessionId: created.id, tokenHash: refresh.hash, expiresAt },
      });
      await recordAudit(tx, {
        action: 'auth.password_changed',
        actor: { type: 'USER', userId },
        resource: { type: 'user', id: userId },
        context,
        // The current session is replaced, not lost: count only the other devices.
        metadata: {
          otherSessionsRevoked: Math.max(0, count - 1),
          replacedSessionId: currentSessionId,
          newSessionId: created.id,
        },
      });
      await writeOutboxEvent(tx, {
        type: 'auth.password_changed',
        aggregate: { type: 'user', id: userId },
        payload: { userId },
      });
      return created;
    });

    // Security alert. Best effort: the change has already happened.
    await this.#sender
      .send({ channel: 'EMAIL', to: user.email, template: 'password_changed', data: {} })
      .catch(() => undefined);
    return this.#issue(userId, session, refresh.token);
  }

  async #issue(userId: string, session: Session, refreshToken: string): Promise<IssuedTokens> {
    const roles = await this.#db.userRole.findMany({
      where: { userId },
      select: { role: { select: { name: true } } },
    });
    const access = await this.#tokens.signAccessToken({
      userId,
      sessionId: session.id,
      roles: roles.map((r) => r.role.name),
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  async #revokeSession(sessionId: string, reason: string): Promise<boolean> {
    const { count } = await this.#db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(this.#now()), revokeReason: reason },
    });
    return count === 1;
  }

  async #revokeForReuse(session: Session, context: AuditContext): Promise<void> {
    const revokedNow = await this.#revokeSession(session.id, 'TOKEN_REUSE');
    // Audited every time, even if already revoked: replaying an old token is itself a signal.
    await recordAudit(this.#db, {
      action: 'auth.token_reuse_detected',
      actor: { type: 'SYSTEM' },
      resource: { type: 'session', id: session.id },
      context,
      metadata: { userId: session.userId, sessionRevokedNow: revokedNow },
    });
  }

  /**
   * Creates the account, its KYC profile, its USER role and an audit row in one transaction.
   * A taken handle is reported (handles are public); a taken email or phone is reported as
   * ACCOUNT_EXISTS without saying which, to limit account enumeration.
   */
  async register(input: RegisterInput, context: AuditContext): Promise<User> {
    // Hash outside the transaction: ~50 ms of CPU shouldn't hold a database connection.
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.#db.$transaction(async (tx) => {
        const user = await createUser(tx, {
          email: input.email,
          phone: input.phone,
          handle: input.handle,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash,
        });
        await recordAudit(tx, {
          action: 'user.registered',
          actor: { type: 'USER', userId: user.id },
          resource: { type: 'user', id: user.id },
          context,
        });
        return user;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_handle_key')) {
        throw new ConflictError('That handle is already taken.', {
          code: ErrorCode.HANDLE_TAKEN,
          cause: err,
        });
      }
      // Email or phone: one message for both, so registration can't confirm which is taken.
      if (!isUniqueViolation(err, 'users_email_key', 'users_phone_key')) throw err;
      throw new ConflictError('An account with these details already exists. Try signing in.', {
        code: ErrorCode.ACCOUNT_EXISTS,
        cause: err,
      });
    }
  }

  /**
   * Checks an email/phone + password pair. Used by login (Stage 7, item 2).
   *
   * - Unknown account → a dummy hash is verified so timing matches a real check, then
   *   INVALID_CREDENTIALS.
   * - Locked account → ACCOUNT_LOCKED **without** checking the password, so guessing during
   *   a lockout learns nothing (not even whether a guess was right).
   * - Wrong password → counted; the 5th consecutive failure locks the account for 15 min.
   * - Suspended/deactivated → revealed only after the password is proven correct.
   * - Success → failure counter reset; the hash is upgraded if parameters have changed.
   */
  async verifyCredentials(
    identifier: string,
    password: string,
    context: AuditContext,
  ): Promise<User> {
    const user = await findUserByIdentifier(this.#db, identifier);
    if (user === null) {
      await verifyAgainstDummy(password);
      throw invalidCredentials();
    }
    return this.#checkPassword(user, password, context, 'login');
  }

  /**
   * Re-authentication for sensitive actions by a signed-in user (contact change, deactivation,
   * password change): proves the person holding the access token also knows the password.
   * Shares login's lockout, so a stolen access token can't be used to guess the password here
   * either. A wrong password is INCORRECT_PASSWORD (403), not 401: the token itself is fine
   * and the client must not respond by refreshing or signing out.
   */
  async confirmPassword(userId: string, password: string, context: AuditContext): Promise<User> {
    const user = await this.#db.user.findUniqueOrThrow({ where: { id: userId } });
    return this.#checkPassword(user, password, context, 'reauth');
  }

  async #checkPassword(
    user: User,
    password: string,
    context: AuditContext,
    purpose: 'login' | 'reauth',
  ): Promise<User> {
    const now = this.#now();
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > now) {
      throw new ForbiddenError('Too many failed sign-in attempts. Try again later.', {
        code: ErrorCode.ACCOUNT_LOCKED,
      });
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.#recordFailedAttempt(user, context, purpose);
      throw purpose === 'login' ? invalidCredentials() : incorrectPassword();
    }

    if (isDisabled(user)) {
      await recordAudit(this.#db, {
        action: 'auth.login_failed',
        actor: { type: 'USER', userId: user.id },
        context,
        metadata: { reason: 'account_disabled', status: user.status },
      });
      throw accountDisabled();
    }

    const updates: { failedLoginCount?: number; lockedUntil?: null; passwordHash?: string } = {};
    if (user.failedLoginCount > 0 || user.lockedUntil !== null) {
      updates.failedLoginCount = 0;
      updates.lockedUntil = null;
    }
    if (needsRehash(user.passwordHash)) updates.passwordHash = await hashPassword(password);
    if (Object.keys(updates).length === 0) return user;
    return this.#db.user.update({ where: { id: user.id }, data: updates });
  }

  async #recordFailedAttempt(
    user: User,
    context: AuditContext,
    purpose: 'login' | 'reauth',
  ): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      // Atomic increment: concurrent wrong guesses can't undercount.
      const { failedLoginCount } = await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      await recordAudit(tx, {
        action: purpose === 'login' ? 'auth.login_failed' : 'auth.reauth_failed',
        actor: { type: 'USER', userId: user.id },
        context,
        metadata: { reason: 'wrong_password', consecutiveFailures: failedLoginCount },
      });
      if (failedLoginCount >= MAX_FAILED_LOGINS) {
        const lockedUntil = new Date(this.#now() + LOCKOUT_MS);
        // Reset the counter so the user gets a fresh set of attempts once the lock expires.
        await tx.user.update({
          where: { id: user.id },
          data: { lockedUntil, failedLoginCount: 0 },
        });
        await recordAudit(tx, {
          action: 'auth.account_locked',
          actor: { type: 'SYSTEM' },
          resource: { type: 'user', id: user.id },
          context,
          metadata: { lockedUntil, afterFailures: failedLoginCount },
        });
      }
    });
  }
}
