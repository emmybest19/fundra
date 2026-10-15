// Mock channel senders: keep what would have been sent, in memory. The real email/SMS/push
// providers plug in behind the same interfaces (Stage 25); nothing here leaves the process.
import type { ChannelSenders, EmailSender, PushSender, SmsSender } from './notification.types.ts';

export type SentMessage =
  | { channel: 'EMAIL'; to: string; subject: string; text: string }
  | { channel: 'SMS'; to: string; text: string }
  | { channel: 'PUSH'; userId: string; title: string; body: string };

export class MemoryChannelSenders implements ChannelSenders, EmailSender, SmsSender, PushSender {
  readonly sent: SentMessage[] = [];
  /** Test hook: the next sends on this channel fail, as an unreachable provider would. */
  readonly #failing = new Set<SentMessage['channel']>();

  readonly email: EmailSender = this;
  readonly sms: SmsSender = this;
  readonly push: PushSender = this;

  sendEmail(email: { to: string; subject: string; text: string }): Promise<void> {
    return this.#record({ channel: 'EMAIL', ...email });
  }

  sendSms(sms: { to: string; text: string }): Promise<void> {
    return this.#record({ channel: 'SMS', ...sms });
  }

  sendPush(push: { userId: string; title: string; body: string }): Promise<void> {
    return this.#record({ channel: 'PUSH', ...push });
  }

  setFailing(channel: SentMessage['channel'], failing: boolean): void {
    if (failing) this.#failing.add(channel);
    else this.#failing.delete(channel);
  }

  #record(message: SentMessage): Promise<void> {
    if (this.#failing.has(message.channel)) {
      return Promise.reject(new Error(`${message.channel} provider unavailable`));
    }
    this.sent.push(message);
    return Promise.resolve();
  }
}
