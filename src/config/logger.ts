// Pino logger with redaction of secrets (passwords, tokens, OTPs).
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { env, type LOG_LEVELS } from './env.ts';

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerConfig {
  level: LogLevel;
  pretty: boolean;
}

const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'otp',
  'pin',
  'bvn',
  'nin',
] as const;

// Pino redacts exact paths, so cover each key at the top level and up to three levels deep
// (e.g. `password`, `body.password`, `req.body.password`, `payload.user.otp`).
export const REDACT_PATHS = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: 'fundra-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pino serializes `err` (type, message, stack) by default.
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };

  if (destination) return pino(options, destination);

  if (config.pretty) {
    // pino-pretty is a dev dependency; it is only loaded in development.
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
    };
  }
  return pino(options);
}

export const logger = createLogger({
  level: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  pretty: env.NODE_ENV === 'development',
});
