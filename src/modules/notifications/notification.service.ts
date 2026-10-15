// Creates notification records and hands channel delivery to the queue (Stage 17), and serves
// the in-app list. One-time codes don't come through here: they go straight through a
// MessageSender, because queued jobs keep their data (a code must never be stored).
import type { Queue } from 'bullmq';
import { NotFoundError } from '../../common/errors/index.ts';
import { encodeCursor, type CursorPosition } from '../../common/utils/cursor.ts';
import type { NotificationChannel, Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { readPreferences } from '../users/preferences.ts';
import type { MessageSender, NotificationInput, OutgoingMessage } from './notification.types.ts';

/**
 * Keeps messages in memory instead of delivering them. Used by tests (which read the codes
 * back) and until a real email/SMS provider exists (Stage 25). Never logs content: messages
 * can carry one-time codes.
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

/** The job that delivers each outbound channel. IN_APP is delivered by being stored. */
export const CHANNEL_JOBS = {
  EMAIL: 'send-email',
  SMS: 'send-sms',
  PUSH: 'send-push',
} as const satisfies Partial<Record<NotificationChannel, string>>;

export interface DeliverNotificationData {
  notificationId: string;
}

/** PENDING this long without being delivered: the sweep queues it again. */
export const REQUEUE_AFTER_MS = 60_000;

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Prisma.JsonValue;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  notifications: NotificationView[];
  nextCursor: string | null;
  unread: number;
}

export class NotificationService {
  readonly #db: PrismaClient;
  readonly #queue: Pick<Queue, 'add'>;
  readonly #now: () => number;

  constructor(db: PrismaClient, queue: Pick<Queue, 'add'>, now: () => number = Date.now) {
    this.#db = db;
    this.#queue = queue;
    this.#now = now;
  }

  /**
   * Records a notification for every channel the user wants for this category (IN_APP
   * always), then queues delivery of the outbound ones. At most once per source event: the
   * check and the insert run under an advisory lock on (event, user, type), so even two
   * deliveries of the same event at once create one set. Returns the IDs created (none for a
   * repeat).
   */
  async notify(input: NotificationInput): Promise<string[]> {
    const created = await this.#db.$transaction(async (tx) => {
      if (input.sourceEventId !== undefined) {
        const lockKey = `notification:${input.sourceEventId}:${input.userId}:${input.type}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const existing = await tx.notification.findFirst({
          where: {
            userId: input.userId,
            type: input.type,
            data: { path: ['sourceEventId'], equals: input.sourceEventId },
          },
          select: { id: true },
        });
        if (existing !== null) return [];
      }

      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { preferences: true, status: true },
      });
      // A deactivated account gets nothing; its owner signs in nowhere to read it.
      if (user === null || user.status === 'DEACTIVATED') return [];
      const wanted = readPreferences(user.preferences).notifications[input.category];
      const channels: NotificationChannel[] = ['IN_APP'];
      const excluded = new Set(input.excludeChannels ?? []);
      if (wanted.email && !excluded.has('EMAIL')) channels.push('EMAIL');
      if (wanted.sms && !excluded.has('SMS')) channels.push('SMS');
      if (wanted.push && !excluded.has('PUSH')) channels.push('PUSH');

      const data: Prisma.InputJsonObject = {
        ...input.data,
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      };
      const now = new Date(this.#now());
      const rows: { id: string; channel: NotificationChannel }[] = [];
      for (const channel of channels) {
        rows.push(
          await tx.notification.create({
            data: {
              userId: input.userId,
              channel,
              type: input.type,
              title: input.title,
              body: input.body,
              data,
              // Stored is delivered, for the in-app feed.
              ...(channel === 'IN_APP' ? { status: 'SENT', sentAt: now } : {}),
            },
            select: { id: true, channel: true },
          }),
        );
      }
      return rows;
    });

    // After COMMIT, so a job never points at a notification that was rolled back. If queueing
    // fails, the row stays PENDING and the sweep queues it again.
    for (const row of created) {
      if (row.channel !== 'IN_APP') await this.#enqueue(row.id, row.channel);
    }
    return created.map((row) => row.id);
  }

  /** Queues outbound notifications left PENDING (queueing failed, or the job was lost). */
  async requeuePending(limit = 500): Promise<number> {
    const stale = await this.#db.notification.findMany({
      where: {
        status: 'PENDING',
        channel: { in: ['EMAIL', 'SMS', 'PUSH'] },
        createdAt: { lt: new Date(this.#now() - REQUEUE_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, channel: true },
    });
    let queued = 0;
    for (const row of stale) if (await this.#enqueue(row.id, row.channel)) queued++;
    return queued;
  }

  /** Job ID = notification ID: queueing the same one twice is a no-op. */
  async #enqueue(notificationId: string, channel: NotificationChannel): Promise<boolean> {
    if (channel === 'IN_APP') return false;
    const data: DeliverNotificationData = { notificationId };
    try {
      await this.#queue.add(CHANNEL_JOBS[channel], data, { jobId: notificationId });
      return true;
    } catch {
      return false;
    }
  }
}

/** The in-app feed, for the API: read-only apart from read marks. */
export class NotificationFeed {
  readonly #db: PrismaClient;
  readonly #now: () => number;

  constructor(db: PrismaClient, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** The in-app feed, newest first, with the unread count. */
  async list(
    userId: string,
    query: { limit: number; cursor?: CursorPosition | undefined; unreadOnly: boolean },
  ): Promise<NotificationPage> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      channel: 'IN_APP',
      ...(query.unreadOnly ? { readAt: null } : {}),
    };
    const rows = await this.#db.notification.findMany({
      where:
        query.cursor === undefined
          ? where
          : {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: query.cursor.createdAt } },
                    { createdAt: query.cursor.createdAt, id: { lt: query.cursor.id } },
                  ],
                },
              ],
            },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const unread = await this.#db.notification.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
    return {
      notifications: page.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: row.data,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      unread,
    };
  }

  /** Marks one of the user's own in-app notifications read. Someone else's is a 404. */
  async markRead(userId: string, id: string): Promise<void> {
    const { count } = await this.#db.notification.updateMany({
      where: { id, userId, channel: 'IN_APP' },
      data: { readAt: new Date(this.#now()) },
    });
    if (count === 0) throw new NotFoundError('Notification not found.');
  }

  /** Marks everything read. Returns how many changed. */
  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.#db.notification.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date(this.#now()) },
    });
    return count;
  }
}
