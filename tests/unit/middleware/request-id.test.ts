import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../../../src/middleware/request-id.middleware.ts';
import { buildMiddlewareApp } from '../../helpers/middleware-app.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function appEchoingRequestId() {
  const routes = Router();
  routes.get('/echo-id', (req, res) => {
    res.json({ id: req.id });
  });
  return buildMiddlewareApp(routes).app;
}

describe('resolveRequestId', () => {
  it('generates a UUID when none is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID);
  });

  it('keeps a safe caller-supplied ID', () => {
    expect(resolveRequestId('gw-2026.10.01:abc_123')).toBe('gw-2026.10.01:abc_123');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['log injection (newline)', 'abc\nlevel=50 msg=fake'],
    ['spaces and quotes', 'id "x"'],
    ['empty', ''],
  ])('replaces an unsafe ID (%s) with a UUID', (_case, incoming) => {
    expect(resolveRequestId(incoming)).toMatch(UUID);
  });
});

describe('requestId middleware', () => {
  it('returns a generated ID in the header and exposes it to handlers', async () => {
    const res = await request(appEchoingRequestId()).get('/echo-id');

    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body).toEqual({ id: res.headers['x-request-id'] });
  });

  it('propagates a valid incoming X-Request-Id', async () => {
    const res = await request(appEchoingRequestId())
      .get('/echo-id')
      .set('X-Request-Id', 'trace-42');

    expect(res.headers['x-request-id']).toBe('trace-42');
  });

  it('gives every request a different ID', async () => {
    const app = appEchoingRequestId();
    const [a, b] = await Promise.all([request(app).get('/echo-id'), request(app).get('/echo-id')]);

    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});
