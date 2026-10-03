// Forgotten-password flow: a one-time code to the user's email or phone, then a new password.
import { ValidationError } from '../../common/errors/index.ts';
import { writeOutboxEvent } from '../../common/outbox/outbox.writer.ts';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import type { MessageSender } from '../notifications/notification.types.ts';
import { findUserByIdentifier, isDisabled } from '../users/user.service.ts';
import type { OtpService } from './otp.ts';
import { hashPassword, passwordIsNotPersonal } from './password.ts';
import { failClosed, invalidOtp } from './verification.service.ts';

export class PasswordResetService {
  readonly #db: PrismaClient;
  readonly #otp: OtpService;
  readonly #sender: MessageSender;
  readonly #now: () => number;

  constructor(db: PrismaClient, otp: OtpService, sender: MessageSender, now = Date.now) {
    this.#db = db;
    this.#otp = otp;
    this.#sender = sender;
    this.#now = now;
  }

  /**
   * Sends a reset code to the channel named by the identifier (email → email, phone → SMS).
   * Returns normally whether or not the account exists, is disabled, or is cooling down, so
   * the endpoint can't be used to discover accounts.
   */
  async forgot(identifier: string, context: AuditContext): Promise<void> {
    const user = await findUserByIdentifier(this.#db, identifier);
    if (user === null || isDisabled(user)) return;

    const issued = await failClosed(() => this.#otp.issue('password_reset', user.id));
    if (issued === null) return; // cooling down: stay silent

    const byEmail = identifier.includes('@');
    await failClosed(() =>
      this.#sender.send({
        channel: byEmail ? 'EMAIL' : 'SMS',
        to: byEmail ? user.email : user.phone,
        template: 'otp',
        data: { code: issued.code, purpose: 'password_reset' },
      }),
    );
    await recordAudit(this.#db, {
      action: 'auth.password_reset_requested',
      actor: { type: 'SYSTEM' },
      resource: { type: 'user', id: user.id },
      context,
      metadata: { channel: byEmail ? 'email' : 'sms' },
    });
  }

  /**
   * Checks the code, sets the new password, signs out every session, clears any lockout
   * (reset is how a locked-out user recovers) and alerts the user, all audited.
   */
  async reset(
    identifier: string,
    code: string,
    newPassword: string,
    context: AuditContext,
  ): Promise<void> {
    const user = await findUserByIdentifier(this.#db, identifier);
    // Unknown and disabled accounts get the same answer as a wrong code.
    if (user === null || isDisabled(user)) throw invalidOtp();

    // Checked before the code is consumed, so a policy failure doesn't burn the user's code.
    if (!passwordIsNotPersonal(newPassword, user)) {
      throw new ValidationError([
        { path: 'body.newPassword', message: 'Must not contain your handle or email name' },
      ]);
    }

    const result = await failClosed(() => this.#otp.check('password_reset', user.id, code));
    if (result !== 'ok') throw invalidOtp();

    const passwordHash = await hashPassword(newPassword);
    const now = new Date(this.#now());
    await this.#db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      const { count } = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokeReason: 'PASSWORD_CHANGED' },
      });
      await recordAudit(tx, {
        action: 'auth.password_reset',
        actor: { type: 'USER', userId: user.id },
        resource: { type: 'user', id: user.id },
        context,
        metadata: { sessionsRevoked: count },
      });
      await writeOutboxEvent(tx, {
        type: 'auth.password_changed',
        aggregate: { type: 'user', id: user.id },
        payload: { userId: user.id },
      });
    });

    // Security alert. Best effort: the reset has already happened.
    await this.#sender
      .send({ channel: 'EMAIL', to: user.email, template: 'password_changed', data: {} })
      .catch(() => undefined);
  }
}
