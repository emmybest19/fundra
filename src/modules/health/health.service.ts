// Liveness and readiness: is the process up, and should it receive traffic?
import { logger } from '../../config/logger.ts';

export interface HealthCheck {
  /** Short dependency name shown in the readiness report, e.g. `database`. */
  name: string;
  /** Resolves if the dependency is usable; rejects otherwise. */
  check: () => Promise<void>;
  /**
   * Whether the instance should stop receiving traffic while this dependency is down
   * (default true). Use false for shared dependencies the app can degrade without: since
   * every instance shares them, failing readiness would pull all instances at once and
   * turn a partial outage into a full one.
   */
  critical?: boolean;
}

export type CheckStatus = 'up' | 'down';

/**
 * - `ready` (200): every check is up.
 * - `degraded` (200): only non-critical checks are down; keep serving.
 * - `unavailable` (503): a critical check is down.
 * - `draining` (503): shutting down.
 */
export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'unavailable' | 'draining';
  checks: Record<string, CheckStatus>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class HealthService {
  readonly #checks: readonly HealthCheck[];
  readonly #timeoutMs: number;
  #draining = false;

  constructor(checks: readonly HealthCheck[], timeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {
    this.#checks = checks;
    this.#timeoutMs = timeoutMs;
  }

  /** Called at the start of shutdown so load balancers stop sending new traffic. */
  startDraining(): void {
    this.#draining = true;
  }

  /** Runs every check in parallel. Failure reasons are logged, never returned to the caller. */
  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.#checks.map(async ({ name, check, critical = true }) => {
        try {
          await withTimeout(check(), this.#timeoutMs);
          return { name, critical, status: 'up' as const };
        } catch (err) {
          logger.warn({ err, check: name, critical }, 'readiness check failed');
          return { name, critical, status: 'down' as const };
        }
      }),
    );

    const checks = Object.fromEntries(results.map(({ name, status }) => [name, status]));
    if (this.#draining) return { status: 'draining', checks };

    const down = results.filter((result) => result.status === 'down');
    if (down.length === 0) return { status: 'ready', checks };
    if (down.some((result) => result.critical)) return { status: 'unavailable', checks };
    return { status: 'degraded', checks };
  }
}
