import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildMiddlewareApp } from '../../helpers/middleware-app.ts';

const ALLOWED = 'https://app.fundra.dev';

function buildApp() {
  const routes = Router();
  routes.get('/ping', (_req, res) => {
    res.json({ data: 'pong' });
  });
  return buildMiddlewareApp(routes, [ALLOWED]).app;
}

describe('security headers', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(buildApp()).get('/ping');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });
});

describe('CORS', () => {
  it('allows a listed origin and exposes the request ID header', async () => {
    const res = await request(buildApp()).get('/ping').set('Origin', ALLOWED);

    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('gives an unlisted origin no CORS headers, so the browser blocks it', async () => {
    const res = await request(buildApp()).get('/ping').set('Origin', 'https://evil.example');

    expect(res.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('answers preflight requests for money-moving POSTs', async () => {
    const res = await request(buildApp())
      .options('/api/v1/transfers')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization, Idempotency-Key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('does not affect requests without an Origin header', async () => {
    const res = await request(buildApp()).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers).not.toHaveProperty('access-control-allow-origin');
  });
});
