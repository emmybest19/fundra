import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ErrorCode,
  NotFoundError,
  ValidationError,
  normalizeError,
} from '../../../src/common/errors/index.ts';

describe('normalizeError', () => {
  it('returns AppErrors unchanged', () => {
    const error = new NotFoundError();

    expect(normalizeError(error)).toBe(error);
  });

  it('turns a ZodError into a 422 with one detail per issue', () => {
    const schema = z.object({
      amount: z.string().regex(/^[1-9][0-9]*$/),
      recipient: z.object({ handle: z.string() }),
    });
    const result = schema.safeParse({ amount: 12.5, recipient: {} });
    if (result.success) throw new Error('expected validation to fail');

    const error = normalizeError(result.error);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(422);
    expect(error.details?.map((detail) => detail.path)).toEqual(['amount', 'recipient.handle']);
  });

  it('does not echo submitted values back in validation details', () => {
    const result = z.object({ pin: z.string().length(4) }).safeParse({ pin: 'secret-pin-value' });
    if (result.success) throw new Error('expected validation to fail');

    const error = normalizeError(result.error);

    expect(JSON.stringify(error.details)).not.toContain('secret-pin-value');
  });

  it('omits the path for root-level Zod issues', () => {
    const result = z.string().safeParse(42);
    if (result.success) throw new Error('expected validation to fail');

    expect(normalizeError(result.error).details?.[0]).not.toHaveProperty('path');
  });

  it('maps malformed JSON bodies to 400', () => {
    const parseFailure = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
    });

    const error = normalizeError(parseFailure);

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('maps oversized bodies to 413', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });

    expect(normalizeError(tooLarge).statusCode).toBe(413);
  });

  it.each([new Error('db exploded'), 'a thrown string', null, undefined, { weird: true }])(
    'turns unknown throwable %s into a 500 that keeps the cause',
    (thrown) => {
      const error = normalizeError(thrown);

      expect(error.statusCode).toBe(500);
      expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(error.cause).toBe(thrown);
    },
  );
});
