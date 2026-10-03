import { describe, expect, it, vi } from 'vitest';
import {
  MemoryOtpStore,
  OTP_CHECK_SCRIPT,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  OtpService,
  RedisOtpStore,
} from '../../../src/modules/auth/otp.ts';
import { MemoryMessageSender } from '../../../src/modules/notifications/notification.service.ts';

const SECRET = 'unit-test-otp-secret-of-at-least-32-chars';

function setup() {
  let now = Date.UTC(2026, 9, 3, 9, 0, 0);
  const store = new MemoryOtpStore(() => now);
  const otp = new OtpService(store, SECRET);
  return { otp, store, advance: (ms: number) => (now += ms) };
}

async function issueCode(otp: OtpService, purpose = 'email_verification' as const, user = 'u1') {
  const issued = await otp.issue(purpose, user);
  if (issued === null) throw new Error('unexpected cooldown');
  return issued.code;
}

describe('OtpService', () => {
  it('issues 6-digit codes, leading zeros kept', async () => {
    const { otp, advance } = setup();
    for (let i = 0; i < 30; i++) {
      advance(OTP_RESEND_COOLDOWN_MS);
      expect(await issueCode(otp)).toMatch(/^\d{6}$/);
    }
  });

  it('accepts the right code exactly once', async () => {
    const { otp } = setup();
    const code = await issueCode(otp);

    expect(await otp.check('email_verification', 'u1', code)).toBe('ok');
    expect(await otp.check('email_verification', 'u1', code)).toBe('missing');
  });

  it('binds a code to its purpose and user', async () => {
    const { otp } = setup();
    const code = await issueCode(otp, 'email_verification', 'u1');

    expect(await otp.check('password_reset', 'u1', code)).toBe('missing');
    expect(await otp.check('email_verification', 'u2', code)).toBe('missing');
    expect(await otp.check('email_verification', 'u1', code)).toBe('ok');
  });

  it(`destroys the code after ${String(OTP_MAX_ATTEMPTS)} wrong attempts, even if the next guess is right`, async () => {
    const { otp } = setup();
    const code = await issueCode(otp);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await otp.check('email_verification', 'u1', wrong)).toBe('mismatch');
    }
    expect(await otp.check('email_verification', 'u1', code)).toBe('missing');
  });

  it('expires codes after 10 minutes', async () => {
    const { otp, advance } = setup();
    const code = await issueCode(otp);

    advance(OTP_TTL_MS + 1);

    expect(await otp.check('email_verification', 'u1', code)).toBe('missing');
  });

  it('enforces a 60-second resend cooldown per user and purpose', async () => {
    const { otp, advance } = setup();
    await issueCode(otp);

    expect(await otp.issue('email_verification', 'u1')).toBeNull();
    expect(await otp.issue('phone_verification', 'u1')).not.toBeNull();
    expect(await otp.issue('email_verification', 'u2')).not.toBeNull();
    advance(OTP_RESEND_COOLDOWN_MS);
    expect(await otp.issue('email_verification', 'u1')).not.toBeNull();
  });

  it('a new code replaces the old one', async () => {
    const { otp, advance } = setup();
    const first = await issueCode(otp);
    advance(OTP_RESEND_COOLDOWN_MS);
    const second = await issueCode(otp);

    if (first !== second) {
      expect(await otp.check('email_verification', 'u1', first)).toBe('mismatch');
    }
    expect(await otp.check('email_verification', 'u1', second)).toBe('ok');
  });

  it('never gives the store the code itself, only a keyed hash', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const otp = new OtpService(
      { put, check: vi.fn(), acquireCooldown: vi.fn().mockResolvedValue(true) },
      SECRET,
    );

    const issued = await otp.issue('password_reset', 'u1');
    const [key, hash] = put.mock.calls[0] as [string, string];

    expect(key).toBe('otp:password_reset:u1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(issued?.code ?? '');
  });
});

describe('RedisOtpStore', () => {
  it('runs the atomic check script with the key, hash and attempt limit', async () => {
    const evalFn = vi.fn().mockResolvedValue('ok');
    const store = new RedisOtpStore({ eval: evalFn, multi: vi.fn(), set: vi.fn() });

    await expect(store.check('otp:k', 'h', 5)).resolves.toBe('ok');
    expect(evalFn).toHaveBeenCalledWith(OTP_CHECK_SCRIPT, 1, 'otp:k', 'h', 5);
  });

  it('rejects an unexpected script reply', async () => {
    const store = new RedisOtpStore({
      eval: vi.fn().mockResolvedValue(1),
      multi: vi.fn(),
      set: vi.fn(),
    });

    await expect(store.check('otp:k', 'h', 5)).rejects.toThrow('Unexpected OTP script reply');
  });

  it('acquires the cooldown with SET NX PX', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const store = new RedisOtpStore({ eval: vi.fn(), multi: vi.fn(), set });

    expect(await store.acquireCooldown('cd', 60_000)).toBe(true);
    expect(await store.acquireCooldown('cd', 60_000)).toBe(false);
    expect(set).toHaveBeenCalledWith('cd', '1', 'PX', 60_000, 'NX');
  });
});

describe('MemoryMessageSender', () => {
  it('keeps messages per recipient and exposes the last code', async () => {
    const sender = new MemoryMessageSender();
    await sender.send({
      channel: 'EMAIL',
      to: 'a@b.co',
      template: 'otp',
      data: { code: '111111', purpose: 'email_verification' },
    });
    await sender.send({ channel: 'EMAIL', to: 'a@b.co', template: 'password_changed', data: {} });
    await sender.send({
      channel: 'SMS',
      to: '+2348000000000',
      template: 'otp',
      data: { code: '222222', purpose: 'phone_verification' },
    });

    expect(sender.messagesTo('a@b.co')).toHaveLength(2);
    expect(sender.lastCodeTo('a@b.co')).toBe('111111');
    expect(sender.lastCodeTo('+2348000000000')).toBe('222222');
    expect(sender.lastCodeTo('nobody@b.co')).toBeUndefined();
  });
});
