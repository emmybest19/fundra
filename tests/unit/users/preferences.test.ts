import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  preferencesPatch,
  readPreferences,
} from '../../../src/modules/users/preferences.ts';

describe('stored preferences', () => {
  it('reads the column default {} as the full defaults', () => {
    expect(readPreferences({})).toEqual({
      notifications: {
        transactions: { email: true, sms: false, push: true },
        security: { email: true, sms: true, push: true },
        marketing: { email: false, sms: false, push: false },
      },
    });
  });

  it('fills in anything missing from a partial row', () => {
    const read = readPreferences({ notifications: { marketing: { email: true } } });
    expect(read.notifications.marketing).toEqual({ email: true, sms: false, push: false });
    expect(read.notifications.transactions).toEqual(DEFAULT_PREFERENCES.notifications.transactions);
  });

  it('drops retired keys instead of failing', () => {
    const read = readPreferences({ theme: 'dark', notifications: { digest: true } });
    expect(read).toEqual(DEFAULT_PREFERENCES);
  });

  it('falls back to the defaults for an unreadable value', () => {
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(readPreferences({ notifications: { transactions: { sms: 'yes' } } })).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it('always reads security email as on, even if a row says otherwise', () => {
    expect(
      readPreferences({ notifications: { security: { email: false } } }).notifications.security
        .email,
    ).toBe(true);
  });
});

describe('preferences patch', () => {
  it('accepts a partial update', () => {
    expect(
      preferencesPatch.safeParse({ notifications: { transactions: { sms: true } } }).success,
    ).toBe(true);
  });

  it.each([
    ['an empty body', {}],
    ['unknown top-level keys', { theme: 'dark' }],
    ['unknown nested keys', { notifications: { transactions: { whatsapp: true } } }],
    ['non-boolean values', { notifications: { marketing: { email: 'yes' } } }],
    ['turning off security emails', { notifications: { security: { email: false } } }],
  ])('rejects %s', (_label, body) => {
    expect(preferencesPatch.safeParse(body).success).toBe(false);
  });

  it('allows turning off security SMS and push', () => {
    expect(
      preferencesPatch.safeParse({ notifications: { security: { sms: false, push: false } } })
        .success,
    ).toBe(true);
  });
});

describe('mergePreferences', () => {
  it('changes only what the patch names', () => {
    const patch = preferencesPatch.parse({
      notifications: { transactions: { sms: true }, marketing: { push: true } },
    });
    const merged = mergePreferences(DEFAULT_PREFERENCES, patch);

    expect(merged.notifications.transactions).toEqual({ email: true, sms: true, push: true });
    expect(merged.notifications.marketing).toEqual({ email: false, sms: false, push: true });
    expect(merged.notifications.security).toEqual(DEFAULT_PREFERENCES.notifications.security);
  });

  it('builds on earlier changes rather than resetting them', () => {
    const first = mergePreferences(
      DEFAULT_PREFERENCES,
      preferencesPatch.parse({ notifications: { marketing: { email: true } } }),
    );
    const second = mergePreferences(
      first,
      preferencesPatch.parse({ notifications: { marketing: { sms: true } } }),
    );
    expect(second.notifications.marketing).toEqual({ email: true, sms: true, push: false });
  });

  it('does not mutate its input', () => {
    const before = structuredClone(DEFAULT_PREFERENCES);
    mergePreferences(
      DEFAULT_PREFERENCES,
      preferencesPatch.parse({ notifications: { transactions: { email: false } } }),
    );
    expect(DEFAULT_PREFERENCES).toEqual(before);
  });
});
