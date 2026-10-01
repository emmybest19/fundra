import { describe, expect, it } from 'vitest';
import {
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../../src/common/errors/index.ts';
import { errorBody, success } from '../../../src/common/utils/response.ts';

describe('success', () => {
  it('wraps data', () => {
    expect(success({ id: 'w_1' })).toEqual({ data: { id: 'w_1' } });
  });

  it('adds meta when given', () => {
    expect(success([1, 2], { nextCursor: null })).toEqual({
      data: [1, 2],
      meta: { nextCursor: null },
    });
  });

  it('keeps falsy data such as null', () => {
    expect(success(null)).toEqual({ data: null });
  });
});

describe('errorBody', () => {
  it('includes code, message and request ID for client errors', () => {
    expect(errorBody(new NotFoundError('Wallet not found.'), 'req-123')).toEqual({
      error: { code: 'NOT_FOUND', message: 'Wallet not found.', requestId: 'req-123' },
    });
  });

  it('includes validation details', () => {
    const body = errorBody(new ValidationError([{ path: 'amount', message: 'Required' }]));

    expect(body.error.details).toEqual([{ path: 'amount', message: 'Required' }]);
  });

  it('omits fields that are not set', () => {
    expect(errorBody(new NotFoundError()).error).not.toHaveProperty('details');
    expect(errorBody(new NotFoundError()).error).not.toHaveProperty('requestId');
  });

  it.each([
    new InternalError('relation "wallets" does not exist', {
      details: [{ message: 'SELECT * FROM wallets' }],
    }),
    new ServiceUnavailableError('redis ECONNREFUSED 127.0.0.1:6379'),
  ])('hides internal messages and details for server errors', (error) => {
    const body = errorBody(error, 'req-9');

    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(body.error).not.toHaveProperty('details');
    expect(body.error.requestId).toBe('req-9');
    expect(JSON.stringify(body)).not.toMatch(/wallets|redis|127\.0\.0\.1/);
  });
});
