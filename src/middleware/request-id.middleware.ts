// Assigns a request ID and returns it in the X-Request-Id header.
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// A caller-supplied ID (e.g. from a gateway) is reused only if it is short and safe to log.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(incoming: string | undefined): string {
  return incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = resolveRequestId(req.get(REQUEST_ID_HEADER));
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
