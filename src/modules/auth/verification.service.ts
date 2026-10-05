// Email and phone verification with one-time codes.
import {
  BadRequestError,
  ConflictError,
  ErrorCode,
  ServiceUnavailableError,
  TooManyRequestsError,
} from '../../common/errors/index.ts';
import type { PrismaClient, User } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import type { MessageSender } from '../notifications/notification.types.ts';
import { statusAfterVerification } from '../users/user-status.ts';
import { OTP_RESEND_COOLDOWN_MS, type OtpPurpose, type OtpService } from './otp.ts';

export type VerificationChannel = 'email' | 'phone';

const PURPOSE: Record<VerificationChannel, OtpPurpose> = {
  email: 'email_verification',
  phone: 'phone_verification',
};

export const invalidOtp = () =>
  new BadRequestError(
    'The code is incorrect or has expired. After 5 wrong attempts, request a new code.',
    { code: ErrorCode.INVALID_OTP },
  );

export const otpCooldown = () =>
  new TooManyRequestsError(
    `A code was sent recently. Wait ${String(OTP_RESEND_COOLDOWN_MS / 1_000)} seconds before requesting another.`,
    { code: ErrorCode.OTP_COOLDOWN },
  );

/**
 * Code storage (Redis) and delivery failures fail closed: no code is ever skipped. The
 * underlying error is kept for the logs; the client gets a generic 503.
 */
export async function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    throw new ServiceUnavailableError(undefined, { cause: err });
  }
}

const isVerified = (user: User, channel: VerificationChannel) =>
  (channel === 'email' ? user.emailVerifiedAt : user.phoneVerifiedAt) !== null;

export class VerificationService {
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

  /** Sends a 6-digit code to the user's email or phone (60-second resend cooldown). */
  async request(userId: string, channel: VerificationChannel): Promise<void> {
    const user = await this.#db.user.findUniqueOrThrow({ where: { id: userId } });
    if (isVerified(user, channel)) {
      throw new ConflictError(`Your ${channel} is already verified.`, {
        code: ErrorCode.ALREADY_VERIFIED,
      });
    }

    const issued = await failClosed(() => this.#otp.issue(PURPOSE[channel], userId));
    if (issued === null) throw otpCooldown();

    await failClosed(() =>
      this.#sender.send({
        channel: channel === 'email' ? 'EMAIL' : 'SMS',
        to: channel === 'email' ? user.email : user.phone,
        template: 'otp',
        data: { code: issued.code, purpose: PURPOSE[channel] },
      }),
    );
  }

  /**
   * Checks the code and marks the channel verified. Once both email and phone are verified,
   * a PENDING_VERIFICATION account becomes ACTIVE (required later for moving money).
   */
  async confirm(
    userId: string,
    channel: VerificationChannel,
    code: string,
    context: AuditContext,
  ): Promise<User> {
    const user = await this.#db.user.findUniqueOrThrow({ where: { id: userId } });
    if (isVerified(user, channel)) {
      throw new ConflictError(`Your ${channel} is already verified.`, {
        code: ErrorCode.ALREADY_VERIFIED,
      });
    }

    const result = await failClosed(() => this.#otp.check(PURPOSE[channel], userId, code));
    if (result !== 'ok') throw invalidOtp();

    const now = new Date(this.#now());
    return this.#db.$transaction(async (tx) => {
      const verified = await tx.user.update({
        where: { id: userId },
        data: channel === 'email' ? { emailVerifiedAt: now } : { phoneVerifiedAt: now },
      });
      const activate = statusAfterVerification(verified) !== verified.status;
      await recordAudit(tx, {
        action: channel === 'email' ? 'user.email_verified' : 'user.phone_verified',
        actor: { type: 'USER', userId },
        resource: { type: 'user', id: userId },
        context,
        metadata: { activated: activate },
      });
      return activate
        ? tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } })
        : verified;
    });
  }
}
