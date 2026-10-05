import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from '../../../src/common/utils/mask.ts';

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('emma.okafor@fundra.dev')).toBe('e***@fundra.dev');
    expect(maskEmail('e@fundra.dev')).toBe('e***@fundra.dev');
  });

  it('masks malformed input entirely', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@fundra.dev')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('keeps the country code and the last 3 digits, same length', () => {
    expect(maskPhone('+2348012345678')).toBe('+234*******678');
    expect(maskPhone('+2348012345678')).toHaveLength('+2348012345678'.length);
  });

  it('masks anything that is not E.164 entirely', () => {
    expect(maskPhone('08012345678')).toBe('***');
    expect(maskPhone('+12')).toBe('***');
  });
});
