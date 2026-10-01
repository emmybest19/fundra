// Process entry point: starts the HTTP server and shuts it down gracefully.
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { registerShutdown } from './common/utils/shutdown.ts';
import { checkDatabase, disconnectDatabase } from './config/database.ts';
import { env } from './config/env.ts';
import { logger } from './config/logger.ts';
import { HealthService } from './modules/health/health.service.ts';

// The process starts even if a dependency is down; readiness reports 503 until it recovers,
// so orchestrators hold traffic instead of crash-looping the app. Redis is added in Stage 6.
const health = new HealthService([{ name: 'database', check: () => checkDatabase() }]);

const server = createServer(createApp({ health }));

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
  cleanup: [() => disconnectDatabase()],
});
