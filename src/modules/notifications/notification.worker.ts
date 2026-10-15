// Delivers email / SMS / push notifications (the send-email, send-sms and send-push jobs).
import type { PrismaClient } from '../../generated/prisma/client.ts';
import type { ChannelSenders } from './notification.types.ts';

export type DeliveryResult = 'SENT' | 'ALREADY_SENT' | 'SKIPPED';

export class NotificationDelivery {
  readonly #db: PrismaClient;
  readonly #senders: ChannelSenders;
  readonly #now: () => number;

  constructor(db: PrismaClient, senders: ChannelSenders, now: () => number = Date.now) {
    this.#db = db;
    this.#senders = senders;
    this.#now = now;
  }

  /**
   * Sends one notification through its channel and marks it SENT. A provider error is
   * thrown, so the job retries with backoff; on the last attempt (`final`) the notification
   * is marked FAILED first. Delivery is at-least-once: a crash between sending and marking
   * can send twice, which for an alert is better than not at all.
   */
  async deliver(notificationId: string, options: { final: boolean }): Promise<DeliveryResult> {
    const row = await this.#db.notification.findUnique({
      where: { id: notificationId },
      include: { user: { select: { email: true, phone: true } } },
    });
    if (row === null || row.channel === 'IN_APP') return 'SKIPPED';
    if (row.status === 'SENT') return 'ALREADY_SENT';

    try {
      switch (row.channel) {
        case 'EMAIL':
          await this.#senders.email.sendEmail({
            to: row.user.email,
            subject: row.title,
            text: row.body,
          });
          break;
        case 'SMS':
          // SMS is short: the body alone, prefixed so it's recognisable.
          await this.#senders.sms.sendSms({ to: row.user.phone, text: `Fundra: ${row.body}` });
          break;
        case 'PUSH':
          await this.#senders.push.sendPush({
            userId: row.userId,
            title: row.title,
            body: row.body,
          });
          break;
      }
    } catch (err) {
      if (options.final) {
        await this.#db.notification.update({
          where: { id: notificationId },
          data: { status: 'FAILED' },
        });
      }
      throw err;
    }
    await this.#db.notification.update({
      where: { id: notificationId },
      data: { status: 'SENT', sentAt: new Date(this.#now()) },
    });
    return 'SENT';
  }
}
