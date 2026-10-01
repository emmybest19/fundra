// Redis connection(s) shared by cache, rate limiting and BullMQ.
import { Redis } from 'ioredis';
import { env } from './env.ts';
import { logger } from './logger.ts';

export const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * Creates a client tuned for request paths: commands fail immediately while Redis is
 * unreachable instead of queueing, so no HTTP request hangs on Redis. It reconnects in the
 * background with capped backoff. (BullMQ needs different options; see Stage 16.)
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, MAX_RECONNECT_DELAY_MS),
  });

  // ioredis retries forever and emits an error per attempt; log once per outage.
  let outageReported = false;
  client.on('ready', () => {
    if (outageReported) logger.info('redis connection restored');
    outageReported = false;
  });
  client.on('error', (err) => {
    if (outageReported) return;
    outageReported = true;
    logger.warn({ err }, 'redis connection error; retrying in the background');
  });

  return client;
}

/** Shared client. Connected by server.ts at startup (`lazyConnect`), so importing it is free. */
export const redis = createRedisClient(env.REDIS_URL);

/** Starts connecting. Never rejects: failures are logged and retried in the background. */
export function connectRedis(client: Redis = redis): void {
  if (client.status !== 'wait') return;
  client.connect().catch(() => {
    // Already logged by the 'error' handler; ioredis keeps retrying.
  });
}
