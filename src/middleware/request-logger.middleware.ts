// Logs one line per completed request and gives each request a child logger (req.log).
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { logger } from '../config/logger.ts';

interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
}

interface SerializedResponse {
  statusCode: number;
}

export function createRequestLogger(baseLogger: Logger) {
  return pinoHttp({
    logger: baseLogger,
    // The requestId middleware runs first and has already chosen the ID.
    genReqId: (req) => req.id,
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    // Keep request lines small: no headers, bodies or query strings beyond the URL.
    serializers: {
      req: (req: SerializedRequest) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
    },
  });
}

export const requestLogger = createRequestLogger(logger);
