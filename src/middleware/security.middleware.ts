// Security headers, CORS policy and request body limits.
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from '../config/env.ts';
import { REQUEST_ID_HEADER } from './request-id.middleware.ts';

export const JSON_BODY_LIMIT = '100kb';

export const securityHeaders = helmet();

/**
 * Browsers may call the API only from listed origins. Requests without an Origin header
 * (servers, mobile apps, curl) are unaffected: CORS is a browser protection, not authentication.
 */
export function createCorsPolicy(allowedOrigins: readonly string[]) {
  return cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
    // Let browser clients read request IDs and back off when rate limited.
    exposedHeaders: [
      REQUEST_ID_HEADER,
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'Idempotent-Replayed',
    ],
    maxAge: 600,
  });
}

export const corsPolicy = createCorsPolicy(env.CORS_ORIGINS);

export const jsonBody = express.json({ limit: JSON_BODY_LIMIT });
