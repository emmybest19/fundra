// Express router for webhooks. Mounted before JSON parsing: signatures cover the raw bytes,
// and express.json() would replace them with a re-parsed object.
import express, { Router } from 'express';
import { createWebhookController } from './webhook.controller.ts';
import type { WebhookService } from './webhook.service.ts';

/** Provider payloads are small; anything bigger is not a webhook. */
export const WEBHOOK_BODY_LIMIT = '64kb';

export function createWebhookRouter({ webhooks }: { webhooks: WebhookService }): Router {
  const controller = createWebhookController(webhooks);
  const router = Router();

  // Any content type: the signature, not the header, says whether the bytes are genuine.
  router.post(
    '/payments',
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    controller.receivePayment,
  );

  return router;
}
