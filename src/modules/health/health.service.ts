// Liveness and readiness: is the process up, and should it receive traffic?
import { logger } from '../../config/logger.ts';

export interface HealthCheck {
  /** Short dependency name shown in the readiness report, e.g. `database`. */
  name: string;
  /** Resolves if the dependency is usable; rejects otherwise. */
  check: () => Promise<void>;
}

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'unavailable' | 'draining';
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
      this.#checks.map(async ({ name, check }): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(check(), this.#timeoutMs);
          return [name, 'up'];
        } catch (err) {
          logger.warn({ err, check: name }, 'readiness check failed');
          return [name, 'down'];
        }
      }),
    );

    const checks = Object.fromEntries(results);
    if (this.#draining) return { status: 'draining', checks };
    const allUp = results.every(([, status]) => status === 'up');
    return { status: allUp ? 'ready' : 'unavailable', checks };
  }
}
