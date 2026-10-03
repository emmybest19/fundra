import { describe, expect, it } from 'vitest';
import { registerBody } from '../../../src/modules/auth/auth.schema.ts';
import { email, handle, phone } from '../../../src/modules/users/user.schema.ts';

describe('email', () => {
  it('trims and lower-cases', () => {
    expect(email.parse('  Emma.O@Fundra.DEV ')).toBe('emma.o@fundra.dev');
  });

  it.each(['not-an-email', 'a@', '@fundra.dev', ''])('rejects %j', (value) => {
    expect(email.safeParse(value).success).toBe(false);
  });
});

describe('phone', () => {
  it.each([
    ['+2348012345678', '+2348012345678'],
    ['08012345678', '+2348012345678'],
    ['0801 234 5678', '+2348012345678'],
    ['+234 (801) 234-5678', '+2348012345678'],
    ['+447700900123', '+447700900123'],
  ])('normalises %j to %j', (input, expected) => {
    expect(phone.parse(input)).toBe(expected);
  });

  it.each(['8012345678', '0801234567', '+0123456789', 'phone', '+234801234567890123'])(
    'rejects %j',
    (value) => {
      expect(phone.safeParse(value).success).toBe(false);
    },
  );
});

describe('handle', () => {
  it.each([
    ['Emma_O', 'emma_o'],
    ['@tolu', 'tolu'],
    ['  bola99 ', 'bola99'],
  ])('normalises %j to %j', (input, expected) => {
    expect(handle.parse(input)).toBe(expected);
  });

  it.each(['ab', 'a'.repeat(21), 'has space', 'dash-ed', 'émma'])('rejects %j', (value) => {
    expect(handle.safeParse(value).success).toBe(false);
  });
});

describe('registerBody', () => {
  const valid = {
    email: 'Emma@Fundra.dev',
    phone: '08012345678',
    handle: '@Emma_O',
    firstName: ' Emma ',
    lastName: 'Okafor',
    password: 'purple elephant 42',
  };

  it('normalises every field', () => {
    expect(registerBody.parse(valid)).toEqual({
      email: 'emma@fundra.dev',
      phone: '+2348012345678',
      handle: 'emma_o',
      firstName: 'Emma',
      lastName: 'Okafor',
      password: 'purple elephant 42',
    });
  });

  it('rejects a password containing the handle', () => {
    const result = registerBody.safeParse({ ...valid, password: 'iamemma_o!!!' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['password']);
  });

  it('gives a short password exactly one, accurate error', () => {
    const result = registerBody.safeParse({ ...valid, password: 'short' });

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Must be at least 10 characters',
    ]);
  });

  it('rejects unknown fields such as a self-assigned role', () => {
    expect(registerBody.safeParse({ ...valid, role: 'SUPER_ADMIN' }).success).toBe(false);
  });
});
