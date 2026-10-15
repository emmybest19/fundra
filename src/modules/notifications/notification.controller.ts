// HTTP layer for the in-app notification feed.
import type { Request, Response } from 'express';
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { feedQuery, notificationParams } from './notification.schema.ts';
import type { NotificationFeed } from './notification.service.ts';

/** Notifications mention money and sign-ins: never cached. */
const noStore = (res: Response): Response =>
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

export function createNotificationController(feed: NotificationFeed) {
  return {
    list: validated({ query: feedQuery }, async ({ query }, req, res) => {
      const page = await feed.list(authOf(req).userId, {
        limit: query.limit,
        cursor: query.cursor,
        unreadOnly: query.unread,
      });
      noStore(res).json(
        success(
          { notifications: page.notifications },
          { limit: query.limit, nextCursor: page.nextCursor, unread: page.unread },
        ),
      );
    }),

    markRead: validated({ params: notificationParams }, async ({ params }, req, res) => {
      await feed.markRead(authOf(req).userId, params.id);
      res.status(204).end();
    }),

    markAllRead: async (req: Request, res: Response) => {
      const marked = await feed.markAllRead(authOf(req).userId);
      noStore(res).json(success({ marked }));
    },
  };
}
