import { describe, expect, it } from 'vitest';
import {
  documentParams,
  tier1Body,
  tier2Body,
  tier3Body,
} from '../../../src/modules/kyc/kyc.schema.ts';

describe('tier1Body', () => {
  it('accepts a real calendar date', () => {
    expect(tier1Body.safeParse({ dateOfBirth: '1995-04-12' }).success).toBe(true);
    expect(tier1Body.safeParse({ dateOfBirth: '2000-02-29' }).success).toBe(true);
  });

  it.each(['2001-02-29', '1995-13-01', '12/04/1995', '1995-4-12', '1899-12-31', ''])(
    'rejects %s',
    (dateOfBirth) => {
      expect(tier1Body.safeParse({ dateOfBirth }).success).toBe(false);
    },
  );
});

describe('tier2Body', () => {
  it('accepts 11 digits and strips spaces copied from a card', () => {
    expect(tier2Body.parse({ type: 'NIN', idNumber: '222 1234 5678' })).toEqual({
      type: 'NIN',
      idNumber: '22212345678',
    });
  });

  it('rejects other lengths, letters and unknown types', () => {
    expect(tier2Body.safeParse({ type: 'BVN', idNumber: '2221234567' }).success).toBe(false);
    expect(tier2Body.safeParse({ type: 'BVN', idNumber: '2221234567a' }).success).toBe(false);
    expect(tier2Body.safeParse({ type: 'SSN', idNumber: '22212345678' }).success).toBe(false);
  });
});

describe('tier3Body', () => {
  it('defaults the country to NG and upper-cases it', () => {
    expect(
      tier3Body.parse({ address: { line1: '1 Marina', city: 'Lagos', state: 'Lagos' } }).address
        .country,
    ).toBe('NG');
    expect(
      tier3Body.parse({ address: { line1: '1 Marina', city: 'Accra', state: 'GA', country: 'gh' } })
        .address.country,
    ).toBe('GH');
  });

  it('requires line1, city and state, and refuses unknown fields', () => {
    expect(tier3Body.safeParse({ address: { line1: '1 Marina', city: 'Lagos' } }).success).toBe(
      false,
    );
    expect(
      tier3Body.safeParse({
        address: { line1: '1 Marina', city: 'Lagos', state: 'Lagos', lat: 6.4 },
      }).success,
    ).toBe(false);
  });
});

describe('documentParams', () => {
  it('accepts only the known document types', () => {
    expect(documentParams.safeParse({ type: 'UTILITY_BILL' }).success).toBe(true);
    expect(documentParams.safeParse({ type: 'utility_bill' }).success).toBe(false);
    expect(documentParams.safeParse({ type: '../secret' }).success).toBe(false);
  });
});
