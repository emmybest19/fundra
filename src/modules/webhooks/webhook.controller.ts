// Receives provider webhooks (raw body) and acknowledges fast.
import type { Request, Response } from 'express';
import { BadRequestError } from '../../common/errors/index.ts';
import { success } from '../../common/utils/response.ts';
import type { WebhookService } from './webhook.service.ts';

export function createWebhookController(webhooks: WebhookService) {
  return {
    receivePayment: async (req: Request, res: Response) => {
      // express.raw() leaves the exact bytes the provider signed; anything else is unusable.
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new BadRequestError('Expected a webhook body.');
      }
      const received = await webhooks.receive(req.body, req.headers);
      req.log.info(
        {
          webhookEventId: received.webhookEventId,
          eventId: received.eventId,
          status: received.status,
        },
        'payment webhook received',
      );
      // 200 for duplicates and ignored events too: the provider must stop retrying them.
      res.status(200).json(success({ received: true, status: received.status }));
    },
  };
}
