// Notification types and channels.
import type { OtpPurpose } from '../auth/otp.ts';

export type MessageChannel = 'EMAIL' | 'SMS';

/** Templates the sender knows how to render. Data is template-specific. */
export type OutgoingMessage =
  | {
      channel: MessageChannel;
      to: string;
      template: 'otp';
      data: {
        code: string;
        purpose: OtpPurpose;
      };
    }
  | {
      channel: MessageChannel;
      to: string;
      template: 'password_changed' | 'account_deactivated';
      data: Record<string, never>;
    }
  | {
      channel: MessageChannel;
      /** The **old** address: the alert must reach the owner, not whoever made the change. */
      to: string;
      template: 'contact_changed';
      data: { changed: 'email' | 'phone' };
    };

/**
 * Sends a message immediately. Stage 17 provides the real implementation (queued email/SMS);
 * until then the in-memory sender is used. Messages may contain one-time codes: senders must
 * never log or persist message content.
 */
export interface MessageSender {
  send(message: OutgoingMessage): Promise<void>;
}
