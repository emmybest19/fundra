// Express router for webhooks. Mounted before JSON parsing: signatures cover the raw bytes,
// and express.json() would replace them with a re-parsed object.
import express, { Router } from 'express';
import { createWebhookController, type WebhookQueue } from './webhook.controller.ts';
import type { WebhookProcessor } from './webhook.processor.ts';
import type { WebhookService } from './webhook.service.ts';

/** Provider payloads are small; anything bigger is not a webhook. */
export const WEBHOOK_BODY_LIMIT = '64kb';

export interface WebhookRouterDependencies {
  webhooks: WebhookService;
  /** Where processing is handed off (the `webhooks` queue). */
  queue: WebhookQueue;
  /** The fallback when the queue is unavailable. */
  processor: WebhookProcessor;
}

export function createWebhookRouter({
  webhooks,
  queue,
  processor,
}: WebhookRouterDependencies): Router {
  const controller = createWebhookController(webhooks, queue, processor);
  const router = Router();

  // Any content type: the signature, not the header, says whether the bytes are genuine.
  router.post(
    '/payments',
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    controller.receivePayment,
  );

  return router;
}
