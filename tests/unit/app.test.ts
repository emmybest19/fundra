import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { HealthService } from '../../src/modules/health/health.service.ts';

function appWith(health = new HealthService([])) {
  return createApp({ health });
}

describe('createApp', () => {
  it('serves liveness with no-store caching and a request ID', async () => {
    const res = await request(appWith()).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('serves readiness as 200 when all checks pass', async () => {
    const health = new HealthService([{ name: 'database', check: () => Promise.resolve() }]);

    const res = await request(appWith(health)).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up' } });
  });

  it('serves readiness as 503 when a check fails', async () => {
    const health = new HealthService([
      { name: 'database', check: () => Promise.reject(new Error('down')) },
    ]);

    const res = await request(appWith(health)).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'down' } });
  });

  it('serves readiness as 503 while draining', async () => {
    const health = new HealthService([]);
    health.startDraining();

    const res = await request(appWith(health)).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'draining', checks: {} });
  });

  it('applies security headers to every response', async () => {
    const res = await request(appWith()).get('/health/live');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });

  it('returns the standard 404 envelope under /api/v1', async () => {
    const res = await request(appWith()).get('/api/v1/wallets');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('trusts no proxy by default, so X-Forwarded-For cannot spoof the client IP', () => {
    expect(appWith().get('trust proxy')).toBe(0);
  });
});
