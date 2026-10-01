// Process entry point: starts the HTTP server and shuts it down gracefully.
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { registerShutdown } from './common/utils/shutdown.ts';
import { env } from './config/env.ts';
import { logger } from './config/logger.ts';
import { HealthService } from './modules/health/health.service.ts';

// Readiness checks are registered as dependencies are added: database (Stage 5), Redis (Stage 6).
const health = new HealthService([]);

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
  // Database, Redis and queue connections are closed here as they are added.
  cleanup: [],
});
