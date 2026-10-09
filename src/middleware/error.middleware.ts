// Maps errors to the standard error response; never leaks internals.
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { classifyDatabaseError, NotFoundError, normalizeError } from '../common/errors/index.ts';
import { errorBody } from '../common/utils/response.ts';

/** Mounted after all routes: anything that reaches it matched no route. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Route not found.'));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Too late to send a JSON error; let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const error = normalizeError(err);

  // Untranslated database failures: log what kind, never the SQL. `integrity` marks the
  // database refusing to break the books (append-only, unbalanced), which alerting should page on.
  const database = classifyDatabaseError(error.cause ?? err);
  if (database !== null) {
    const level = database.integrity || error.statusCode === 500 ? 'error' : 'warn';
    req.log[level]({ database }, 'database error');
  }
  if (error.retryAfterSeconds !== undefined) {
    res.set('Retry-After', String(error.retryAfterSeconds));
  }

  // For server errors, hand the real error to pino-http so the request's log line
  // is written at error level with the stack. The client only gets a generic message.
  if (!error.expose) {
    res.err = error.cause instanceof Error ? error.cause : error;
  }

  res
    .status(error.statusCode)
    .json(errorBody(error, typeof req.id === 'string' ? req.id : undefined));
};
