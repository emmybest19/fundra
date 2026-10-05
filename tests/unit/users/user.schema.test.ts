import { describe, expect, it } from 'vitest';
import {
  changePasswordBody,
  confirmEmailChangeBody,
  confirmPhoneChangeBody,
  deactivateBody,
  requestEmailChangeBody,
  requestPhoneChangeBody,
  updateProfileBody,
} from '../../../src/modules/users/user.schema.ts';

describe('updateProfileBody', () => {
  it('normalises the fields it shares with registration', () => {
    expect(updateProfileBody.parse({ firstName: '  Ada ', handle: '@Ada_O' })).toEqual({
      firstName: 'Ada',
      handle: 'ada_o',
    });
  });

  it.each([
    ['an empty body', {}],
    ['only undefined fields', { firstName: undefined }],
    ['email (changed through its own verified flow)', { email: 'new@fundra.dev' }],
    ['status', { status: 'ACTIVE' }],
    ['an invalid handle', { handle: 'a b' }],
    ['a blank name', { lastName: '   ' }],
  ])('rejects %s', (_label, body) => {
    expect(updateProfileBody.safeParse(body).success).toBe(false);
  });
});

describe('contact change bodies', () => {
  it('normalises the new address like registration does', () => {
    expect(
      requestEmailChangeBody.parse({ newEmail: ' New@Fundra.DEV ', password: 'x' }).newEmail,
    ).toBe('new@fundra.dev');
    expect(
      requestPhoneChangeBody.parse({ newPhone: '0801 234 5679', password: 'x' }).newPhone,
    ).toBe('+2348012345679');
  });

  it('requires the password to request and a 6-digit code to confirm', () => {
    expect(requestEmailChangeBody.safeParse({ newEmail: 'new@fundra.dev' }).success).toBe(false);
    expect(
      confirmEmailChangeBody.safeParse({ newEmail: 'new@fundra.dev', code: '12345' }).success,
    ).toBe(false);
    expect(
      confirmPhoneChangeBody.safeParse({ newPhone: '+2348012345679', code: '123456' }).success,
    ).toBe(true);
  });
});

describe('deactivateBody', () => {
  it('takes the password and an optional reason from a fixed list', () => {
    expect(deactivateBody.safeParse({ password: 'x' }).success).toBe(true);
    expect(deactivateBody.safeParse({ password: 'x', reason: 'PRIVACY_CONCERNS' }).success).toBe(
      true,
    );
  });

  it('rejects free-text reasons (they would be kept forever in the audit log)', () => {
    expect(deactivateBody.safeParse({ password: 'x', reason: 'my landlord is…' }).success).toBe(
      false,
    );
  });

  it('requires the password', () => {
    expect(deactivateBody.safeParse({ reason: 'OTHER' }).success).toBe(false);
  });
});

describe('changePasswordBody', () => {
  it('accepts any current password but holds the new one to the policy', () => {
    expect(
      changePasswordBody.safeParse({ currentPassword: 'old', newPassword: 'brand new secret 9' })
        .success,
    ).toBe(true);
    expect(
      changePasswordBody.safeParse({ currentPassword: 'old', newPassword: 'short' }).success,
    ).toBe(false);
    expect(
      changePasswordBody.safeParse({ currentPassword: '', newPassword: 'brand new secret 9' })
        .success,
    ).toBe(false);
  });
});
