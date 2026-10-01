import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../../src/common/utils/shutdown.ts';
import { logger } from '../../../src/config/logger.ts';

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * A real HTTP server with a slow route and a route that never answers.
 * `arrived` resolves once a request has reached a handler, so tests start shutdown
 * only after the request is truly in flight, not after a guessed delay.
 */
async function startServer(): Promise<{
  server: Server;
  url: string;
  arrived: Promise<undefined>;
}> {
  const { promise: arrived, resolve } = Promise.withResolvers<undefined>();
  const markArrived = () => {
    resolve(undefined);
  };
  const app = express();
  app.get('/slow', async (_req, res) => {
    markArrived();
    await delay(200);
    res.json({ done: true });
  });
  app.get('/hang', () => {
    markArrived();
    // never responds
  });

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}`, arrived };
}

describe('createShutdown', () => {
  it('lets in-flight requests finish, refuses new ones, cleans up, then exits 0', async () => {
    const { server, url, arrived } = await startServer();
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      server,
      logger,
      onShutdownStart: () => order.push('start'),
      cleanup: [() => Promise.resolve(void order.push('cleanup'))],
      exit,
    });

    const inFlight = fetch(`${url}/slow`);
    await arrived;
    const done = shutdown('SIGTERM');

    const res = await inFlight;
    expect(res.status).toBe(200);
    await expect(fetch(`${url}/slow`)).rejects.toThrow();

    await done;
    expect(order).toEqual(['start', 'cleanup']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('force-closes connections that outlive the timeout and exits 1', async () => {
    const { server, url, arrived } = await startServer();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 100, exit });

    const hung = fetch(`${url}/hang`);
    await arrived;
    const started = Date.now();
    await shutdown('SIGTERM');

    await expect(hung).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('runs every cleanup step even if one fails, then exits 1', async () => {
    const { server } = await startServer();
    const exit = vi.fn();
    const second = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      server,
      logger,
      cleanup: [() => Promise.reject(new Error('redis quit failed')), second],
      exit,
    });

    await shutdown('SIGTERM');

    expect(second).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('uses the requested exit code for crash-triggered shutdowns', async () => {
    const { server } = await startServer();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, exit });

    await shutdown('uncaughtException', 1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('only shuts down once when called repeatedly', async () => {
    const { server } = await startServer();
    const exit = vi.fn();
    const onShutdownStart = vi.fn();
    const shutdown = createShutdown({ server, logger, onShutdownStart, exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(onShutdownStart).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
