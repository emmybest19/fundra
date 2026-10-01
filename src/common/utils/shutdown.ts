import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface ShutdownOptions {
  server: Server;
  logger: Logger;
  /** How long in-flight requests get to finish before connections are force-closed. */
  timeoutMs?: number;
  /** Runs first, e.g. to make readiness report `draining`. */
  onShutdownStart?: () => void;
  /** Run in order after HTTP has drained: close queues, Redis, then the database. */
  cleanup?: readonly (() => Promise<void>)[];
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
// If cleanup itself hangs, give up this long after the drain deadline.
const HARD_EXIT_GRACE_MS = 5_000;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    // Keep-alive sockets with no request in flight would otherwise hold the server open.
    server.closeIdleConnections();
  });
}

/**
 * Returns a shutdown function: stop accepting connections, let in-flight requests finish,
 * run cleanup, exit. Calling it more than once has no further effect.
 */
export function createShutdown({
  server,
  logger,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  onShutdownStart,
  cleanup = [],
  exit = (code) => process.exit(code),
}: ShutdownOptions): (reason: string, exitCode?: number) => Promise<void> {
  let started = false;

  return async (reason, exitCode = 0) => {
    if (started) return;
    started = true;
    let code = exitCode;

    logger.info({ reason }, 'shutting down');
    onShutdownStart?.();

    const drainDeadline = setTimeout(() => {
      logger.error({ timeoutMs }, 'in-flight requests did not finish in time; closing connections');
      code = 1;
      server.closeAllConnections();
    }, timeoutMs);
    const hardExit = setTimeout(() => {
      logger.fatal('shutdown hung; exiting');
      exit(1);
    }, timeoutMs + HARD_EXIT_GRACE_MS);
    drainDeadline.unref();
    hardExit.unref();

    await closeServer(server);
    clearTimeout(drainDeadline);

    for (const step of cleanup) {
      try {
        await step();
      } catch (err) {
        logger.error({ err }, 'cleanup step failed');
        code = 1;
      }
    }
    clearTimeout(hardExit);

    logger.info({ exitCode: code }, 'shutdown complete');
    exit(code);
  };
}

/** Wires shutdown to SIGTERM/SIGINT and to crashes. A second signal forces an immediate exit. */
export function registerShutdown(options: ShutdownOptions): void {
  const { logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const shutdown = createShutdown(options);
  let signalled = false;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (signalled) {
        logger.warn({ signal }, 'second signal received; forcing exit');
        exit(1);
        return;
      }
      signalled = true;
      void shutdown(signal);
    });
  }

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
}
