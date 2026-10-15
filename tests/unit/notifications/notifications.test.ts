import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { NotFoundError } from '../../../src/common/errors/index.ts';
import { encodeCursor } from '../../../src/common/utils/cursor.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { MemoryChannelSenders } from '../../../src/modules/notifications/channel-senders.ts';
import { createNotificationRouter } from '../../../src/modules/notifications/notification.routes.ts';
import { feedQuery } from '../../../src/modules/notifications/notification.schema.ts';
import type { NotificationFeed } from '../../../src/modules/notifications/notification.service.ts';

const ID = '01a1407d-89c4-7fff-9ad3-9b767ad1c8c6';

describe('feedQuery', () => {
  it('defaults to 20, everything; unread=true filters', () => {
    expect(feedQuery.parse({})).toEqual({ limit: 20, unread: false });
    expect(feedQuery.parse({ unread: 'true', limit: '5' })).toEqual({ limit: 5, unread: true });
  });

  it('takes our cursors and refuses anything else', () => {
    const cursor = encodeCursor({ createdAt: new Date('2026-10-15T10:00:00.000Z'), id: ID });
    expect(feedQuery.parse({ cursor }).cursor?.id).toBe(ID);
    expect(feedQuery.safeParse({ cursor: 'not-ours' }).success).toBe(false);
    expect(feedQuery.safeParse({ unread: 'yes' }).success).toBe(false);
    expect(feedQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(feedQuery.safeParse({ userId: ID }).success).toBe(false);
  });
});

describe('notifications router', () => {
  const fakeAuthenticate: RequestHandler = (req, res, next) => {
    const userId = req.get('x-test-user');
    if (userId === undefined) {
      res.status(401).json({});
      return;
    }
    req.auth = { userId, sessionId: 's', roles: ['USER'], status: 'ACTIVE' };
    next();
  };
  function setup() {
    const feed = {
      list: vi.fn().mockResolvedValue({ notifications: [{ id: ID }], nextCursor: null, unread: 3 }),
      markRead: vi.fn().mockResolvedValue(undefined),
      markAllRead: vi.fn().mockResolvedValue(3),
    };
    const app = express();
    app.use(express.json());
    app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
    app.use(
      '/notifications',
      createNotificationRouter({
        feed: feed as unknown as NotificationFeed,
        authenticate: fakeAuthenticate,
      }),
    );
    app.use(errorHandler);
    return { app, feed };
  }

  it('needs authentication', async () => {
    const { app } = setup();
    expect((await request(app).get('/notifications')).status).toBe(401);
  });

  it("lists the caller's own feed with the unread count, never cached", async () => {
    const { app, feed } = setup();
    const res = await request(app).get('/notifications?unread=true').set('X-Test-User', 'u');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: { notifications: [{ id: ID }] },
      meta: { limit: 20, nextCursor: null, unread: 3 },
    });
    expect(feed.list).toHaveBeenCalledWith('u', { limit: 20, cursor: undefined, unreadOnly: true });
  });

  it('marks one read (204), and refuses a malformed ID before the service', async () => {
    const { app, feed } = setup();
    expect(
      (await request(app).post(`/notifications/${ID}/read`).set('X-Test-User', 'u')).status,
    ).toBe(204);
    expect(feed.markRead).toHaveBeenCalledWith('u', ID);
    expect(
      (await request(app).post('/notifications/nope/read').set('X-Test-User', 'u')).status,
    ).toBe(422);
    expect(feed.markRead).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for someone else's notification", async () => {
    const { app, feed } = setup();
    feed.markRead.mockRejectedValueOnce(new NotFoundError('Notification not found.'));
    const res = await request(app).post(`/notifications/${ID}/read`).set('X-Test-User', 'u');

    expect(res.status).toBe(404);
    expect((res.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('marks everything read and says how many', async () => {
    const { app } = setup();
    const res = await request(app).post('/notifications/read-all').set('X-Test-User', 'u');
    expect(res.body).toEqual({ data: { marked: 3 } });
  });
});

describe('MemoryChannelSenders', () => {
  it('keeps what each channel would send', async () => {
    const senders = new MemoryChannelSenders();
    await senders.email.sendEmail({ to: 'a@b.c', subject: 'S', text: 'T' });
    await senders.sms.sendSms({ to: '+2348030000000', text: 'T' });
    await senders.push.sendPush({ userId: 'u', title: 'S', body: 'T' });

    expect(senders.sent.map((m) => m.channel)).toEqual(['EMAIL', 'SMS', 'PUSH']);
  });

  it('can fail one channel like an unreachable provider, then recover', async () => {
    const senders = new MemoryChannelSenders();
    senders.setFailing('SMS', true);

    await expect(senders.sms.sendSms({ to: 'x', text: 'T' })).rejects.toThrow(/unavailable/);
    await senders.email.sendEmail({ to: 'a@b.c', subject: 'S', text: 'T' });
    senders.setFailing('SMS', false);
    await senders.sms.sendSms({ to: 'x', text: 'T' });
    expect(senders.sent.map((m) => m.channel)).toEqual(['EMAIL', 'SMS']);
  });
});
