// Express router for the signed-in user's in-app notifications.
import { Router, type RequestHandler } from 'express';
import { createNotificationController } from './notification.controller.ts';
import type { NotificationFeed } from './notification.service.ts';

export interface NotificationRouterDependencies {
  feed: NotificationFeed;
  authenticate: RequestHandler;
}

export function createNotificationRouter({
  feed,
  authenticate,
}: NotificationRouterDependencies): Router {
  const controller = createNotificationController(feed);
  const router = Router();

  router.use(authenticate);
  router.get('/', controller.list);
  router.post('/read-all', controller.markAllRead);
  router.post('/:id/read', controller.markRead);

  return router;
}
