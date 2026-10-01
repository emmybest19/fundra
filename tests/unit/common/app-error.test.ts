import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableError,
  ValidationError,
} from '../../../src/common/errors/index.ts';

describe('AppError subclasses', () => {
  it.each([
    [new BadRequestError(), 400, ErrorCode.BAD_REQUEST],
    [new ValidationError([{ message: 'x' }]), 422, ErrorCode.VALIDATION_ERROR],
    [new UnauthorizedError(), 401, ErrorCode.UNAUTHENTICATED],
    [new ForbiddenError(), 403, ErrorCode.FORBIDDEN],
    [new NotFoundError(), 404, ErrorCode.NOT_FOUND],
    [new ConflictError(), 409, ErrorCode.CONFLICT],
    [new PayloadTooLargeError(), 413, ErrorCode.PAYLOAD_TOO_LARGE],
    [new UnprocessableError('Insufficient funds.'), 422, ErrorCode.UNPROCESSABLE],
    [new TooManyRequestsError(), 429, ErrorCode.RATE_LIMITED],
    [new InternalError(), 500, ErrorCode.INTERNAL_ERROR],
    [new ServiceUnavailableError(), 503, ErrorCode.SERVICE_UNAVAILABLE],
  ])('%s has status %i and code %s', (error, statusCode, code) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(statusCode);
    expect(error.code).toBe(code);
    expect(error.message).not.toBe('');
  });

  it('uses the subclass name', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
  });

  it('accepts a custom message and code', () => {
    const error = new ConflictError('That handle is taken.', { code: ErrorCode.CONFLICT });

    expect(error.message).toBe('That handle is taken.');
    expect(error.statusCode).toBe(409);
  });

  it('keeps the underlying cause for logging', () => {
    const cause = new Error('connection refused');

    expect(new InternalError(undefined, { cause }).cause).toBe(cause);
  });

  it('exposes 4xx errors and hides 5xx errors', () => {
    expect(new NotFoundError().expose).toBe(true);
    expect(new InternalError().expose).toBe(false);
    expect(new ServiceUnavailableError().expose).toBe(false);
  });

  it('carries validation details', () => {
    const details = [{ path: 'amount', message: 'Required' }];

    expect(new ValidationError(details).details).toEqual(details);
  });
});
