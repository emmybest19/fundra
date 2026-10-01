import { Writable } from 'node:stream';
import express, { type Router } from 'express';
import { createLogger } from '../../src/config/logger.ts';
import { errorHandler, notFoundHandler } from '../../src/middleware/error.middleware.ts';
import { requestId } from '../../src/middleware/request-id.middleware.ts';
import { createRequestLogger } from '../../src/middleware/request-logger.middleware.ts';
import {
  createCorsPolicy,
  jsonBody,
  securityHeaders,
} from '../../src/middleware/security.middleware.ts';

export type LogLine = Record<string, unknown> & { level: number; msg?: string };

/**
 * An Express app with the production middleware chain around the given routes,
 * plus a capture of every log line it writes.
 */
export function buildMiddlewareApp(routes: Router, allowedOrigins: readonly string[] = []) {
  const logs: LogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()) as LogLine);
      callback();
    },
  });
  const log = createLogger({ level: 'info', pretty: false }, destination);

  const app = express();
  app.use(requestId);
  app.use(createRequestLogger(log));
  app.use(securityHeaders);
  app.use(createCorsPolicy(allowedOrigins));
  app.use(jsonBody);
  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, logs };
}
