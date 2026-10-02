import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { HealthService, type HealthCheck } from '../../../src/modules/health/health.service.ts';

const up = (name: string): HealthCheck => ({ name, check: () => Promise.resolve() });
const down = (name: string): HealthCheck => ({
  name,
  check: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5432')),
});

describe('HealthService.readiness', () => {
  it('is ready with no checks registered', async () => {
    await expect(new HealthService([]).readiness()).resolves.toEqual({
      status: 'ready',
      checks: {},
    });
  });

  it('is ready when every check passes', async () => {
    const report = await new HealthService([up('database'), up('redis')]).readiness();

    expect(report).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  });

  it('is unavailable when a critical check fails, without exposing the reason', async () => {
    const report = await new HealthService([down('database'), up('redis')]).readiness();

    expect(report).toEqual({ status: 'unavailable', checks: { database: 'down', redis: 'up' } });
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
  });

  it('treats checks as critical unless marked otherwise', async () => {
    const report = await new HealthService([down('anything')]).readiness();

    expect(report.status).toBe('unavailable');
  });

  it('is degraded, not unavailable, when only non-critical checks fail', async () => {
    const report = await new HealthService([
      up('database'),
      { ...down('redis'), critical: false },
    ]).readiness();

    expect(report).toEqual({ status: 'degraded', checks: { database: 'up', redis: 'down' } });
  });

  it('is unavailable when critical and non-critical checks both fail', async () => {
    const report = await new HealthService([
      down('database'),
      { ...down('redis'), critical: false },
    ]).readiness();

    expect(report.status).toBe('unavailable');
  });

  it('marks a check that exceeds the timeout as down instead of hanging', async () => {
    const hanging: HealthCheck = { name: 'database', check: () => new Promise(() => undefined) };
    const started = Date.now();

    const report = await new HealthService([hanging], 50).readiness();

    expect(report.checks.database).toBe('down');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports draining once shutdown has started, even if checks pass', async () => {
    const health = new HealthService([up('database')]);

    health.startDraining();

    await expect(health.readiness()).resolves.toEqual({
      status: 'draining',
      checks: { database: 'up' },
    });
  });

  it('runs checks in parallel', async () => {
    // Count overlapping checks instead of timing them, so a busy machine can't fail the test.
    let running = 0;
    let maxRunning = 0;
    const tracked = (name: string): HealthCheck => ({
      name,
      check: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await delay(20);
        running--;
      },
    });

    await new HealthService([tracked('a'), tracked('b'), tracked('c')]).readiness();

    expect(maxRunning).toBe(3);
  });
});
