// Business logic for auth: registration and credential verification.
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  UnauthorizedError,
} from '../../common/errors/index.ts';
import type { PrismaClient, User } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import { email, phone } from '../users/user.schema.ts';
import { createUser } from '../users/user.service.ts';
import type { RegisterInput } from './auth.schema.ts';
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from './password.ts';

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1_000;

/** Same error for "no such account" and "wrong password": nothing to enumerate. */
const invalidCredentials = () =>
  new UnauthorizedError('The email/phone or password is incorrect.', {
    code: ErrorCode.INVALID_CREDENTIALS,
  });

function uniqueViolationTarget(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'P2002') {
    return undefined;
  }
  // The violated constraint is reported in `meta`; its exact shape varies by driver adapter.
  return JSON.stringify('meta' in err ? err.meta : {});
}

export class AuthService {
  readonly #db: PrismaClient;
  readonly #now: () => number;

  constructor(db: PrismaClient, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
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
      const target = uniqueViolationTarget(err);
      if (target === undefined) throw err;
      if (target.includes('handle')) {
        throw new ConflictError('That handle is already taken.', {
          code: ErrorCode.HANDLE_TAKEN,
          cause: err,
        });
      }
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
    const user = await this.#findByIdentifier(identifier);
    if (user === null) {
      await verifyAgainstDummy(password);
      throw invalidCredentials();
    }

    const now = this.#now();
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > now) {
      throw new ForbiddenError('Too many failed sign-in attempts. Try again later.', {
        code: ErrorCode.ACCOUNT_LOCKED,
      });
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.#recordFailedAttempt(user, context);
      throw invalidCredentials();
    }

    if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
      await recordAudit(this.#db, {
        action: 'auth.login_failed',
        actor: { type: 'USER', userId: user.id },
        context,
        metadata: { reason: 'account_disabled', status: user.status },
      });
      throw new ForbiddenError('This account is not active. Contact support.', {
        code: ErrorCode.ACCOUNT_DISABLED,
      });
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

  async #findByIdentifier(identifier: string): Promise<User | null> {
    // Email if it looks like one, otherwise phone. Unparseable input simply finds nobody.
    if (identifier.includes('@')) {
      const parsed = email.safeParse(identifier);
      return parsed.success ? this.#db.user.findUnique({ where: { email: parsed.data } }) : null;
    }
    const parsed = phone.safeParse(identifier);
    return parsed.success ? this.#db.user.findUnique({ where: { phone: parsed.data } }) : null;
  }

  async #recordFailedAttempt(user: User, context: AuditContext): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      // Atomic increment: concurrent wrong guesses can't undercount.
      const { failedLoginCount } = await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      await recordAudit(tx, {
        action: 'auth.login_failed',
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
