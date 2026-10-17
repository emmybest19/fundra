// Accounts end to end: tokens and sessions, lockout, password reset and change, contact
// change, deactivation. Through the HTTP API on in-process PostgreSQL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FAILED_LOGINS } from '../../src/modules/auth/auth.service.ts';
import { startE2e, type E2e } from '../helpers/e2e-app.ts';

let e2e: E2e;
const code = (res: { body: unknown }) => (res.body as { error?: { code?: string } }).error?.code;
interface Tokens {
  data: { accessToken: string; refreshToken: string };
}

beforeAll(async () => {
  e2e = await startE2e();
}, 120_000);

afterAll(async () => {
  await e2e.close();
});

describe('tokens and sessions', () => {
  it('rotates the refresh token; reusing an old one ends the whole session', async () => {
    const ada = await e2e.signUp('ada', { tier1: false });
    const first = await e2e.api('post', '/auth/refresh').send({ refreshToken: ada.refreshToken });
    expect(first.status).toBe(200);
    const rotated = (first.body as Tokens).data.refreshToken;
    expect(rotated).not.toBe(ada.refreshToken);

    const reuse = await e2e.api('post', '/auth/refresh').send({ refreshToken: ada.refreshToken });
    expect(code(reuse)).toBe('REFRESH_TOKEN_REUSED');
    // The session is over: even the newest token no longer works.
    const after = await e2e.api('post', '/auth/refresh').send({ refreshToken: rotated });
    expect(after.status).toBe(401);
  });

  it('lists devices, signs out one, and logout ends the session', async () => {
    const bola = await e2e.signUp('bola', { tier1: false });
    const second = await e2e
      .api('post', '/auth/login')
      .send({ identifier: bola.email, password: bola.password });
    const list = await e2e.api('get', '/auth/sessions', bola);
    const sessions = (list.body as { data: { id: string; current: boolean }[] }).data;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current);
    expect((await e2e.api('delete', `/auth/sessions/${other?.id ?? ''}`, bola)).status).toBe(204);
    expect(
      (
        await e2e
          .api('post', '/auth/refresh')
          .send({ refreshToken: (second.body as Tokens).data.refreshToken })
      ).status,
    ).toBe(401);

    expect(
      (await e2e.api('post', '/auth/logout').send({ refreshToken: bola.refreshToken })).status,
    ).toBe(204);
    expect(
      (await e2e.api('post', '/auth/refresh').send({ refreshToken: bola.refreshToken })).status,
    ).toBe(401);
  });

  it(`locks the account after ${String(MAX_FAILED_LOGINS)} wrong passwords, even for the right one`, async () => {
    const chidi = await e2e.signUp('chidi', { tier1: false });
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const wrong = await e2e
        .api('post', '/auth/login')
        .send({ identifier: chidi.email, password: 'not the password at all' });
      // The 5th failure still answers INVALID_CREDENTIALS; it is what sets the lock.
      expect(code(wrong)).toBe('INVALID_CREDENTIALS');
    }
    const right = await e2e
      .api('post', '/auth/login')
      .send({ identifier: chidi.email, password: chidi.password });
    expect(code(right)).toBe('ACCOUNT_LOCKED');
  });
});

describe('passwords', () => {
  it('resets a forgotten password with the emailed code, and signs everyone out', async () => {
    const dayo = await e2e.signUp('dayo', { tier1: false });
    expect(
      (await e2e.api('post', '/auth/password/forgot').send({ identifier: dayo.email })).status,
    ).toBe(202);
    const sent = e2e.messages
      .messagesTo(dayo.email)
      .filter((m) => m.template === 'otp')
      .at(-1);
    const resetCode = sent?.template === 'otp' ? sent.data.code : '';
    const reset = await e2e.api('post', '/auth/password/reset').send({
      identifier: dayo.email,
      code: resetCode,
      newPassword: 'orange giraffe 77 short',
    });
    expect(reset.status).toBe(204);
    expect(
      (await e2e.api('post', '/auth/refresh').send({ refreshToken: dayo.refreshToken })).status,
    ).toBe(401);
    expect(
      (
        await e2e
          .api('post', '/auth/login')
          .send({ identifier: dayo.email, password: 'orange giraffe 77 short' })
      ).status,
    ).toBe(200);
  });

  it('a wrong reset code is refused', async () => {
    const eze = await e2e.signUp('eze', { tier1: false });
    await e2e.api('post', '/auth/password/forgot').send({ identifier: eze.email });
    const bad = await e2e
      .api('post', '/auth/password/reset')
      .send({ identifier: eze.email, code: '000000', newPassword: 'orange giraffe 77 short' });
    expect(code(bad)).toBe('INVALID_OTP');
  });

  it('changes the password with the current one; a wrong current one is refused', async () => {
    const fola = await e2e.signUp('fola', { tier1: false });
    const wrong = await e2e
      .api('post', '/users/me/password', fola)
      .send({ currentPassword: 'not it at all here', newPassword: 'orange giraffe 77 short' });
    expect(code(wrong)).toBe('INCORRECT_PASSWORD');
    const ok = await e2e
      .api('post', '/users/me/password', fola)
      .send({ currentPassword: fola.password, newPassword: 'orange giraffe 77 short' });
    expect(ok.status).toBe(200);
    expect(e2e.messages.messagesTo(fola.email).some((m) => m.template === 'password_changed')).toBe(
      true,
    );
  });
});

describe('profile and contact details', () => {
  it('changes the email after confirming the new address, alerting the old one', async () => {
    const gbenga = await e2e.signUp('gbenga', { tier1: false });
    const newEmail = `new_${randomUUID().slice(0, 6)}@fundra.dev`;
    const start = await e2e
      .api('post', '/users/me/email', gbenga)
      .send({ newEmail, password: gbenga.password });
    expect(start.status).toBe(202);
    const sent = e2e.messages.messagesTo(newEmail).at(-1);
    const confirm = await e2e.api('post', '/users/me/email/confirm', gbenga).send({
      newEmail,
      code: sent?.template === 'otp' ? sent.data.code : '',
    });
    expect(confirm.status).toBe(200);
    expect((await e2e.api('get', '/users/me', gbenga)).body).toMatchObject({
      data: { user: { email: newEmail } },
    });
    expect(
      e2e.messages.messagesTo(gbenga.email).some((m) => m.template === 'contact_changed'),
    ).toBe(true);
  });

  it('updates the profile and notification preferences', async () => {
    const hana = await e2e.signUp('hana', { tier1: false });
    expect((await e2e.api('patch', '/users/me', hana).send({ firstName: 'Hannah' })).status).toBe(
      200,
    );
    const prefs = await e2e
      .api('patch', '/users/me/preferences', hana)
      .send({ notifications: { transactions: { sms: true } } });
    expect(
      (
        prefs.body as {
          data: { preferences: { notifications: { transactions: { sms: boolean } } } };
        }
      ).data.preferences.notifications.transactions.sms,
    ).toBe(true);
    expect((await e2e.api('get', '/users/me/preferences', hana)).status).toBe(200);
  });
});

describe('deactivation', () => {
  it('refuses while there is money in the wallet, then closes the account when it is empty', async () => {
    const ifeanyi = await e2e.signUp('ifeanyi');
    await e2e.fund(ifeanyi, 100_000n);
    const refused = await e2e
      .api('post', '/users/me/deactivate', ifeanyi)
      .send({ password: ifeanyi.password });
    expect(code(refused)).toBe('ACCOUNT_HAS_BALANCE');

    const jide = await e2e.signUp('jide');
    expect(
      (await e2e.api('post', '/users/me/deactivate', jide).send({ password: jide.password }))
        .status,
    ).toBe(204);
    const wallet = await e2e.db.wallet.findUniqueOrThrow({ where: { id: jide.walletId } });
    expect(wallet.status).toBe('CLOSED');
    const signIn = await e2e
      .api('post', '/auth/login')
      .send({ identifier: jide.email, password: jide.password });
    expect(code(signIn)).toBe('ACCOUNT_DISABLED');
  });
});
