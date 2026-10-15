// Receives provider webhooks (raw body) and acknowledges fast.
import type { Queue } from 'bullmq';
import type { Request, Response } from 'express';
import { BadRequestError } from '../../common/errors/index.ts';
import { success } from '../../common/utils/response.ts';
import type { ProcessWebhookData } from '../../jobs/queues.ts';
import type { WebhookProcessor } from './webhook.processor.ts';
import type { WebhookService } from './webhook.service.ts';
import type { ProcessedWebhook } from './webhook.types.ts';

/** Past this, Redis is treated as down for this delivery and the event processed here. */
export const ENQUEUE_TIMEOUT_MS = 2_000;

export type WebhookQueue = Pick<Queue, 'add'>;

/** Resolves true once queued; false if the queue failed or didn't answer in time. */
async function enqueue(queue: WebhookQueue, webhookEventId: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ENQUEUE_TIMEOUT_MS);
  });
  try {
    const data: ProcessWebhookData = { webhookEventId };
    // Job ID = event ID: a redelivery queues nothing new while the job is still kept.
    const added = queue
      .add('process-webhook', data, { jobId: webhookEventId })
      .then(() => true)
      .catch(() => false);
    return await Promise.race([added, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWebhookController(
  webhooks: WebhookService,
  queue: WebhookQueue,
  processor: WebhookProcessor,
) {
  return {
    receivePayment: async (req: Request, res: Response) => {
      // express.raw() leaves the exact bytes the provider signed; anything else is unusable.
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new BadRequestError('Expected a webhook body.');
      }
      const received = await webhooks.receive(req.body, req.headers);

      // Processing runs in the worker. If the queue can't take the job (Redis down), process
      // here instead: payments keep flowing, and either way the scheduled sweep is the net.
      let queued = false;
      let processed: ProcessedWebhook | undefined;
      if (received.status !== 'IGNORED') {
        queued = await enqueue(queue, received.webhookEventId);
        if (!queued) processed = await processor.process(received.webhookEventId);
      }
      req.log[queued || received.status === 'IGNORED' ? 'info' : 'warn'](
        {
          webhookEventId: received.webhookEventId,
          eventId: received.eventId,
          received: received.status,
          queued,
          processed: processed?.status,
          outcome: processed?.outcome,
          lastError: processed?.lastError,
        },
        queued || received.status === 'IGNORED'
          ? 'payment webhook'
          : 'payment webhook processed inline: the queue is unavailable',
      );
      // 200 whatever happens next: the event is stored, so retrying it is now our job.
      res.status(200).json(success({ received: true, status: received.status }));
    },
  };
}
