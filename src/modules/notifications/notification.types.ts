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

// ─── Notification records and channel delivery (Stage 17) ───────────────────────────────

/** Preference categories (users.preferences.notifications). */
export type NotificationCategory = 'transactions' | 'security' | 'marketing';

/** One thing to tell one user. Text is final: rendered by the caller, never templated later. */
export interface NotificationInput {
  userId: string;
  /** e.g. `transfer.received`. */
  type: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** Shown to the app with the notification. No secrets, no full account numbers. */
  data?: Record<string, string | number | boolean | null>;
  /**
   * The outbox event this came from. A redelivered event (at-least-once) finds its
   * notifications already made and creates nothing new.
   */
  sourceEventId?: string;
  /** Channels already covered another way (e.g. a security email sent directly). */
  excludeChannels?: readonly ('EMAIL' | 'SMS' | 'PUSH')[];
}

/** A delivery channel's provider. Implementations must never log the message text. */
export interface EmailSender {
  sendEmail(email: { to: string; subject: string; text: string }): Promise<void>;
}

export interface SmsSender {
  sendSms(sms: { to: string; text: string }): Promise<void>;
}

/** Push goes to a user's devices; device registration belongs to the provider/app. */
export interface PushSender {
  sendPush(push: { userId: string; title: string; body: string }): Promise<void>;
}

export interface ChannelSenders {
  email: EmailSender;
  sms: SmsSender;
  push: PushSender;
}
