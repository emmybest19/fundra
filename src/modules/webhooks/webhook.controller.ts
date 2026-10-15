// Receives provider webhooks (raw body) and acknowledges fast.
import type { Request, Response } from 'express';
import { BadRequestError } from '../../common/errors/index.ts';
import { success } from '../../common/utils/response.ts';
import type { WebhookProcessor } from './webhook.processor.ts';
import type { WebhookService } from './webhook.service.ts';

export function createWebhookController(webhooks: WebhookService, processor: WebhookProcessor) {
  return {
    receivePayment: async (req: Request, res: Response) => {
      // express.raw() leaves the exact bytes the provider signed; anything else is unusable.
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new BadRequestError('Expected a webhook body.');
      }
      const received = await webhooks.receive(req.body, req.headers);
      // Inline until the job queue exists (Stage 16): a single short transaction. A provider
      // redelivery of an event not yet PROCESSED tries it again; a done one is skipped.
      const processed =
        received.status === 'IGNORED' ? null : await processor.process(received.webhookEventId);
      req.log[processed?.status === 'FAILED' ? 'warn' : 'info'](
        {
          webhookEventId: received.webhookEventId,
          eventId: received.eventId,
          received: received.status,
          processed: processed?.status,
          outcome: processed?.outcome,
          lastError: processed?.lastError,
        },
        'payment webhook',
      );
      // 200 whatever processing did: the event is stored, so retrying it is now our job.
      res.status(200).json(success({ received: true, status: received.status }));
    },
  };
}
