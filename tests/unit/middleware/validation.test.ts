import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { amount, currency, pagination, uuid } from '../../../src/common/validators/index.ts';
import { createLogger } from '../../../src/config/logger.ts';
import { errorHandler } from '../../../src/middleware/error.middleware.ts';
import { createRequestLogger } from '../../../src/middleware/request-logger.middleware.ts';
import { jsonBody } from '../../../src/middleware/security.middleware.ts';
import { validated } from '../../../src/middleware/validation.middleware.ts';

const transferBody = z.strictObject({
  recipientHandle: z.string().min(3),
  amount,
  currency,
  description: z.string().max(140).optional(),
});

function appWith(routes: Router) {
  const app = express();
  app.use(createRequestLogger(createLogger({ level: 'silent', pretty: false })));
  app.use(jsonBody);
  app.use(routes);
  app.use(errorHandler);
  return app;
}

function errorOf(res: request.Response): ApiErrorBody['error'] {
  return (res.body as ApiErrorBody).error;
}

describe('validated', () => {
  it('passes parsed, transformed and typed input to the handler', async () => {
    const seen = vi.fn();
    const routes = Router().post(
      '/wallets/:id/transfers',
      validated(
        { params: z.strictObject({ id: uuid }), body: transferBody },
        (input, _req, res) => {
          // Checked by the TypeScript compiler (npm run typecheck): input is typed from the
          // schemas, transforms included, and unchecked locations are `undefined`.
          expectTypeOf(input.body.amount).toEqualTypeOf<bigint>();
          expectTypeOf(input.body.currency).toEqualTypeOf<'NGN'>();
          expectTypeOf(input.body.description).toEqualTypeOf<string | undefined>();
          expectTypeOf(input.params.id).toEqualTypeOf<string>();
          expectTypeOf(input.query).toEqualTypeOf<undefined>();
          seen(input);
          res.status(201).json({ data: { amount: input.body.amount.toString() } });
        },
      ),
    );
    const id = '01a0f99c-ff58-7000-834f-80b45d33da16';

    const res = await request(appWith(routes))
      .post(`/wallets/${id}/transfers`)
      .send({ recipientHandle: 'tolu', amount: '1000000', currency: 'NGN' });

    expect(res.status).toBe(201);
    expect(seen).toHaveBeenCalledWith({
      params: { id },
      query: undefined,
      body: { recipientHandle: 'tolu', amount: 1_000_000n, currency: 'NGN' },
    });
  });

  it('rejects with 422 and field paths prefixed by location', async () => {
    const handler = vi.fn();
    const routes = Router().post('/transfers', validated({ body: transferBody }, handler));

    const res = await request(appWith(routes))
      .post('/transfers')
      .send({ recipientHandle: 'tolu', amount: 1000000, currency: 'USD' });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(errorOf(res).details?.map((d) => d.path)).toEqual(['body.amount', 'body.currency']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports problems in params, query and body together', async () => {
    const routes = Router().post(
      '/wallets/:id/transfers',
      validated(
        { params: z.strictObject({ id: uuid }), query: pagination, body: transferBody },
        vi.fn(),
      ),
    );

    const res = await request(appWith(routes))
      .post('/wallets/not-a-uuid/transfers?limit=0')
      .send({});

    expect(res.status).toBe(422);
    const paths = errorOf(res).details?.map((d) => d.path) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining(['params.id', 'query.limit', 'body.recipientHandle', 'body.amount']),
    );
  });

  it('rejects unknown fields in strict schemas', async () => {
    const routes = Router().post('/transfers', validated({ body: transferBody }, vi.fn()));

    const res = await request(appWith(routes))
      .post('/transfers')
      .send({ recipientHandle: 'tolu', amount: '100', currency: 'NGN', isAdmin: true });

    expect(res.status).toBe(422);
    expect(errorOf(res).details?.[0]?.message).toMatch(/isAdmin/);
  });

  it('rejects a missing or non-JSON body', async () => {
    const routes = Router().post('/transfers', validated({ body: transferBody }, vi.fn()));

    const res = await request(appWith(routes))
      .post('/transfers')
      .set('Content-Type', 'text/plain')
      .send('amount=100');

    expect(res.status).toBe(422);
    expect(errorOf(res).details?.[0]?.path).toBe('body');
  });

  it('rejects repeated query parameters (parameter pollution)', async () => {
    const routes = Router().get(
      '/transactions',
      validated({ query: pagination }, (_input, _req, res) => {
        res.json({ data: [] });
      }),
    );

    const res = await request(appWith(routes)).get('/transactions?limit=10&limit=100');

    expect(res.status).toBe(422);
    expect(errorOf(res).details?.[0]?.path).toBe('query.limit');
  });

  it('never echoes submitted values back', async () => {
    const routes = Router().post(
      '/pin',
      validated({ body: z.strictObject({ pin: z.string().length(4) }) }, vi.fn()),
    );

    const res = await request(appWith(routes)).post('/pin').send({ pin: 'secret-pin-123' });

    expect(res.status).toBe(422);
    expect(res.text).not.toContain('secret-pin-123');
  });

  it('lets errors thrown by the handler reach the error middleware', async () => {
    const routes = Router().get(
      '/boom',
      validated({}, () => {
        throw new Error('database exploded');
      }),
    );

    const res = await request(appWith(routes)).get('/boom');

    expect(res.status).toBe(500);
    expect(res.text).not.toContain('exploded');
  });
});

describe('amount (D1)', () => {
  it.each([
    ['1', 1n],
    ['1000000', 1_000_000n],
    ['999999999999999', 999_999_999_999_999n],
  ])('accepts "%s" as %s kobo', (input, expected) => {
    expect(amount.parse(input)).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['leading zero', '0100'],
    ['decimal', '100.50'],
    ['negative', '-100'],
    ['plus sign', '+100'],
    ['exponent', '1e6'],
    ['whitespace', ' 100'],
    ['16 digits', '1000000000000000'],
    ['empty', ''],
  ])('rejects %s (%j)', (_case, input) => {
    expect(amount.safeParse(input).success).toBe(false);
  });

  it.each([100, 100.5, null])('rejects non-string %j: JSON numbers can lose precision', (input) => {
    expect(amount.safeParse(input).success).toBe(false);
  });
});

describe('currency', () => {
  it('accepts supported currencies only', () => {
    expect(currency.parse('NGN')).toBe('NGN');
    expect(currency.safeParse('ngn').success).toBe(false);
    expect(currency.safeParse('USD').success).toBe(false);
  });
});

describe('pagination', () => {
  it('defaults limit to 20 and coerces query strings', () => {
    expect(pagination.parse({})).toEqual({ limit: 20 });
    expect(pagination.parse({ limit: '50', cursor: 'abc' })).toEqual({ limit: 50, cursor: 'abc' });
  });

  it.each(['0', '101', '2.5', 'ten'])('rejects limit=%s', (limit) => {
    expect(pagination.safeParse({ limit }).success).toBe(false);
  });

  it('rejects unknown query parameters', () => {
    expect(pagination.safeParse({ limit: '10', sort: 'amount' }).success).toBe(false);
  });
});
