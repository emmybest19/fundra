import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { UnprocessableError } from '../../../src/common/errors/index.ts';
import type { ApiErrorBody } from '../../../src/common/types/api.ts';
import { buildMiddlewareApp, type LogLine } from '../../helpers/middleware-app.ts';

function errorOf(res: request.Response): ApiErrorBody['error'] {
  return (res.body as ApiErrorBody).error;
}

function buildApp() {
  const routes = Router();
  routes.get('/ok', (_req, res) => {
    res.json({ data: 'fine' });
  });
  routes.get('/business-rule', () => {
    throw new UnprocessableError('Insufficient funds.');
  });
  routes.get('/crash', () => {
    throw new Error('relation "wallets" does not exist');
  });
  routes.get('/async-crash', async () => {
    await Promise.resolve();
    throw new Error('redis ECONNREFUSED 127.0.0.1:6379');
  });
  routes.post('/validate', (req, res) => {
    const body = z.object({ amount: z.string() }).parse(req.body);
    res.status(201).json({ data: body });
  });
  routes.post('/echo', (req, res) => {
    res.json({ data: req.body as unknown });
  });
  return buildMiddlewareApp(routes);
}

/** pino-http writes the request line when the response finishes; wait for it. */
async function requestLine(logs: LogLine[]): Promise<LogLine> {
  return vi.waitFor(() => {
    const line = logs.find(
      (entry) => entry.msg === 'request completed' || entry.msg === 'request errored',
    );
    if (!line) throw new Error('request line not written yet');
    return line;
  });
}

describe('error handling', () => {
  it('returns AppErrors with their status, code and the request ID', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/business-rule');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: 'UNPROCESSABLE',
        message: 'Insufficient funds.',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it.each(['/crash', '/async-crash'])(
    'turns an unexpected error in %s into a generic 500',
    async (path) => {
      const { app } = buildApp();

      const res = await request(app).get(path);

      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_ERROR');
      expect(errorOf(res).message).toBe('An unexpected error occurred.');
      expect(res.text).not.toMatch(/wallets|redis|127\.0\.0\.1|at /);
    },
  );

  it('logs a server error once, at error level, with the real error and stack', async () => {
    const { app, logs } = buildApp();

    const res = await request(app).get('/crash');
    const line = await requestLine(logs);

    expect(line.level).toBe(50);
    expect(line.req).toMatchObject({
      id: res.headers['x-request-id'],
      method: 'GET',
      url: '/crash',
    });
    expect(line.err).toMatchObject({ message: 'relation "wallets" does not exist' });
    expect(line.err).toHaveProperty('stack');
    expect(logs.filter((entry) => entry.level >= 50)).toHaveLength(1);
  });

  it('logs client errors at warn level without an error object', async () => {
    const { app, logs } = buildApp();

    await request(app).get('/business-rule');
    const line = await requestLine(logs);

    expect(line.level).toBe(40);
    expect(line).not.toHaveProperty('err');
  });

  it('logs successful requests at info level without headers', async () => {
    const { app, logs } = buildApp();

    await request(app).get('/ok').set('Authorization', 'Bearer secret-token');
    const line = await requestLine(logs);

    expect(line.level).toBe(30);
    expect(line.res).toEqual({ statusCode: 200 });
    expect(JSON.stringify(logs)).not.toContain('secret-token');
  });

  it('turns Zod validation failures into 422 with field details', async () => {
    const { app } = buildApp();

    const res = await request(app).post('/validate').send({ amount: 100 });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(errorOf(res).details?.[0]?.path).toBe('amount');
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('BAD_REQUEST');
  });

  it('rejects JSON bodies over 100kb with 413', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/echo')
      .send({ blob: 'x'.repeat(101 * 1024) });

    expect(res.status).toBe(413);
    expect(errorOf(res).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns the standard 404 body for unknown routes', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: res.headers['x-request-id'],
      },
    });
  });
});
