// Process entry point: starts the HTTP server and shuts it down gracefully.
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { registerShutdown } from './common/utils/shutdown.ts';
import { checkDatabase, disconnectDatabase } from './config/database.ts';
import { env } from './config/env.ts';
import { logger } from './config/logger.ts';
import { checkRedis, connectRedis, disconnectRedis, redis } from './config/redis.ts';
import { RedisRateLimitStore } from './middleware/rate-limit.middleware.ts';
import { HealthService } from './modules/health/health.service.ts';

// The process starts even if a dependency is down; readiness reports it until it recovers,
// so orchestrators hold traffic instead of crash-looping the app.
const health = new HealthService([
  { name: 'database', check: () => checkDatabase() },
  // Non-critical for now: rate limiting fails open, so Redis being down degrades the API
  // rather than breaking it. Revisit when OTPs (Stage 7) and job queues (Stage 16) need it.
  { name: 'redis', check: () => checkRedis(), critical: false },
]);

// Connects in the background; until Redis is reachable the rate limiter fails open.
connectRedis();

const server = createServer(createApp({ health, rateLimitStore: new RedisRateLimitStore(redis) }));

server.on('error', (err) => {
  logger.fatal({ err }, 'HTTP server failed');
  process.exit(1);
});

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Fundra API listening');
});

registerShutdown({
  server,
  logger,
  onShutdownStart: () => {
    health.startDraining();
  },
  // Runs after HTTP has drained, so no in-flight request loses its connection mid-query.
  cleanup: [() => disconnectRedis(), () => disconnectDatabase()],
});
