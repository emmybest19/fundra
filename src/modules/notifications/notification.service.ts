// Creates notifications and enqueues delivery jobs (Stage 17). For now: an in-memory sender.
import type { MessageSender, OutgoingMessage } from './notification.types.ts';

/**
 * Keeps messages in memory instead of delivering them. Used by tests (which read the codes
 * back) and until real delivery exists (Stage 17). Never logs content: messages can carry
 * one-time codes.
 */
export class MemoryMessageSender implements MessageSender {
  readonly #sent: OutgoingMessage[] = [];

  send(message: OutgoingMessage): Promise<void> {
    this.#sent.push(message);
    return Promise.resolve();
  }

  /** Messages sent to an address, oldest first. */
  messagesTo(to: string): readonly OutgoingMessage[] {
    return this.#sent.filter((message) => message.to === to);
  }

  /** The most recent one-time code sent to an address, if any. */
  lastCodeTo(to: string): string | undefined {
    const otps = this.messagesTo(to).filter((m) => m.template === 'otp');
    const last = otps.at(-1);
    return last?.template === 'otp' ? last.data.code : undefined;
  }
}
