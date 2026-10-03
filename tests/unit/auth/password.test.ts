import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  needsRehash,
  password,
  passwordIsNotPersonal,
  PASSWORD_MAX_LENGTH,
  verifyAgainstDummy,
  verifyPassword,
} from '../../../src/modules/auth/password.ts';

describe('hashPassword / verifyPassword', () => {
  it('produces an Argon2id hash with the configured parameters', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('salts every hash, so equal passwords hash differently', async () => {
    expect(await hashPassword('same password 123')).not.toBe(
      await hashPassword('same password 123'),
    );
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery')).toBe(false);
  });

  it('treats a malformed hash as no match instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'anything at all')).toBe(false);
  });

  it('flags hashes made with older parameters for upgrade', async () => {
    const current = await hashPassword('correct horse battery');
    const weaker = current.replace('m=19456,p=1,t=2', 'm=4096,p=1,t=1');

    expect(needsRehash(current)).toBe(false);
    expect(needsRehash(weaker)).toBe(true);
  });

  it('dummy verification always fails and takes comparable time', async () => {
    const hash = await hashPassword('correct horse battery');
    await verifyAgainstDummy('warm up the dummy hash');

    let started = performance.now();
    await verifyPassword(hash, 'wrong password here');
    const real = performance.now() - started;
    started = performance.now();
    const result = await verifyAgainstDummy('wrong password here');
    const dummy = performance.now() - started;

    expect(result).toBe(false);
    // Same algorithm and cost, so the times should be in the same ballpark.
    expect(dummy).toBeGreaterThan(real * 0.3);
    expect(dummy).toBeLessThan(real * 3);
  });
});

describe('password policy', () => {
  it.each(['correct horse', 'ten chars!', 'x'.repeat(PASSWORD_MAX_LENGTH)])(
    'accepts %j',
    (value) => {
      expect(password.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ['too short', 'short1!'],
    ['too long', 'x'.repeat(PASSWORD_MAX_LENGTH + 1)],
    ['mostly spaces', '   abc        '],
  ])('rejects a password that is %s', (_case, value) => {
    expect(password.safeParse(value).success).toBe(false);
  });

  it('rejects passwords containing the handle or email name', () => {
    const personal = { handle: 'emma', email: 'emma.o@fundra.dev' };

    expect(passwordIsNotPersonal('my name is EMMA ok', personal)).toBe(false);
    expect(passwordIsNotPersonal('emma.o-is-great', personal)).toBe(false);
    expect(passwordIsNotPersonal('purple elephant 42', personal)).toBe(true);
  });
});
