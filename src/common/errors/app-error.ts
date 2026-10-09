import { ErrorCode } from './error-codes.ts';

export interface ErrorDetail {
  /** Dotted path to the offending field, e.g. `recipient.handle`. Omitted for non-field errors. */
  path?: string;
  message: string;
}

export interface AppErrorOptions {
  /** Overrides the class's default code, e.g. `INSUFFICIENT_FUNDS` on an UnprocessableError. */
  code?: ErrorCode;
  details?: readonly ErrorDetail[];
  /** The underlying error. Logged, never sent to clients. */
  cause?: unknown;
  /** Sent as `Retry-After` (seconds): the request is safe to repeat after that long. */
  retryAfterSeconds?: number;
}

/**
 * Base class for every error the API deliberately returns. Services throw these;
 * the error middleware turns them into the `{ error: { ... } }` response.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    statusCode: number,
    defaultCode: ErrorCode,
    message: string,
    options: AppErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = options.code ?? defaultCode;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Client-facing message and details are only exposed for 4xx errors. */
  get expose(): boolean {
    return this.statusCode < 500;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'The request is malformed.', options: AppErrorOptions = {}) {
    super(400, ErrorCode.BAD_REQUEST, message, options);
  }
}

export class ValidationError extends AppError {
  constructor(details: readonly ErrorDetail[], options: Omit<AppErrorOptions, 'details'> = {}) {
    super(422, ErrorCode.VALIDATION_ERROR, 'The request contains invalid fields.', {
      ...options,
      details,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.', options: AppErrorOptions = {}) {
    super(401, ErrorCode.UNAUTHENTICATED, message, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    options: AppErrorOptions = {},
  ) {
    super(403, ErrorCode.FORBIDDEN, message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.', options: AppErrorOptions = {}) {
    super(404, ErrorCode.NOT_FOUND, message, options);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state.',
    options: AppErrorOptions = {},
  ) {
    super(409, ErrorCode.CONFLICT, message, options);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The request body is too large.', options: AppErrorOptions = {}) {
    super(413, ErrorCode.PAYLOAD_TOO_LARGE, message, options);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(
    message = 'The request body has an unsupported type.',
    options: AppErrorOptions = {},
  ) {
    super(415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, message, options);
  }
}

/** A well-formed request that breaks a business rule (insufficient funds, limit exceeded, ...). */
export class UnprocessableError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(422, ErrorCode.UNPROCESSABLE, message, options);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(
    message = 'Too many requests. Please try again later.',
    options: AppErrorOptions = {},
  ) {
    super(429, ErrorCode.RATE_LIMITED, message, options);
  }
}

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred.', options: AppErrorOptions = {}) {
    super(500, ErrorCode.INTERNAL_ERROR, message, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'The service is temporarily unavailable.', options: AppErrorOptions = {}) {
    super(503, ErrorCode.SERVICE_UNAVAILABLE, message, options);
  }
}
