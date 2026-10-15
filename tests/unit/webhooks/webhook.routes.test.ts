import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { UnauthorizedError } from '../../../src/common/errors/index.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { MockPaymentProvider } from '../../../src/modules/payments/providers/mock-payment-provider.ts';
import { createWebhookRouter } from '../../../src/modules/webhooks/webhook.routes.ts';
import type { WebhookService } from '../../../src/modules/webhooks/webhook.service.ts';

function setup(receive = vi.fn()) {
  const app = express();
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use('/webhooks', createWebhookRouter({ webhooks: { receive } as unknown as WebhookService }));
  // What the real app does next: JSON parsing must not touch the webhook body.
  app.use(express.json());
  app.use(errorHandler);
  return app;
}

const accepted = { webhookEventId: 'w1', eventId: 'evt_1', status: 'ACCEPTED' };

describe('webhooks router', () => {
  it('hands the service the exact bytes and headers that were signed', async () => {
    const mock = new MockPaymentProvider({
      webhookSecret: 'test-only-mock-payment-webhook-secret-0123',
    });
    // Odd spacing on purpose: re-serialising the JSON would change these bytes.
    const raw = Buffer.from('{ "id":"evt_1",  "event":"customer.created" }');
    const { headers } = mock.signedWebhook({});
    const signature = String(headers['x-mock-signature']);
    const receive = vi.fn().mockResolvedValue(accepted);

    const res = await request(setup(receive))
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signature)
      .send(raw.toString());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { received: true, status: 'ACCEPTED' } });
    const [body, passedHeaders] = receive.mock.calls[0] as [Buffer, Record<string, string>];
    expect(Buffer.compare(body, raw)).toBe(0);
    expect(passedHeaders['x-mock-signature']).toBe(signature);
  });

  it('takes any content type (the signature decides, not the header)', async () => {
    const receive = vi.fn().mockResolvedValue(accepted);
    const res = await request(setup(receive))
      .post('/webhooks/payments')
      .set('Content-Type', 'text/plain')
      .send('{"id":"evt_1"}');

    expect(res.status).toBe(200);
    expect((receive.mock.calls[0] as [Buffer])[0].toString()).toBe('{"id":"evt_1"}');
  });

  it('answers 200 for duplicates and ignored events, so the provider stops retrying', async () => {
    for (const status of ['DUPLICATE', 'IGNORED']) {
      const receive = vi.fn().mockResolvedValue({ ...accepted, status });
      const res = await request(setup(receive)).post('/webhooks/payments').send('{"a":1}');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { received: true, status } });
    }
  });

  it('refuses an empty body before the service runs', async () => {
    const receive = vi.fn();
    const res = await request(setup(receive)).post('/webhooks/payments');

    expect(res.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });

  it('refuses a body over 64 KB with 413 before the service runs', async () => {
    const receive = vi.fn();
    const res = await request(setup(receive))
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .send('x'.repeat(64 * 1024 + 1));

    expect(res.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });

  it("passes the service's 401 through for a bad signature", async () => {
    const receive = vi
      .fn()
      .mockRejectedValue(
        new UnauthorizedError('Invalid webhook signature.', { code: 'INVALID_WEBHOOK_SIGNATURE' }),
      );
    const res = await request(setup(receive)).post('/webhooks/payments').send('{"a":1}');

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });
});
