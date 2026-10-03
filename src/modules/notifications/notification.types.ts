// Notification types and channels.

export type MessageChannel = 'EMAIL' | 'SMS';

/** Templates the sender knows how to render. Data is template-specific. */
export type OutgoingMessage =
  | {
      channel: MessageChannel;
      to: string;
      template: 'otp';
      data: {
        code: string;
        purpose: 'email_verification' | 'phone_verification' | 'password_reset';
      };
    }
  | {
      channel: MessageChannel;
      to: string;
      template: 'password_changed';
      data: Record<string, never>;
    };

/**
 * Sends a message immediately. Stage 17 provides the real implementation (queued email/SMS);
 * until then the in-memory sender is used. Messages may contain one-time codes: senders must
 * never log or persist message content.
 */
export interface MessageSender {
  send(message: OutgoingMessage): Promise<void>;
}
