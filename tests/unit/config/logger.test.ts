import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, logger } from '../../../src/config/logger.ts';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { log: createLogger({ level: 'info', pretty: false }, destination), lines };
}

describe('createLogger', () => {
  it('writes structured JSON with service name and ISO timestamp', () => {
    const { log, lines } = captureLogger();

    log.info({ walletId: 'w_1' }, 'wallet created');

    expect(lines[0]).toMatchObject({
      level: 30,
      service: 'fundra-api',
      walletId: 'w_1',
      msg: 'wallet created',
    });
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts secrets at the top level', () => {
    const { log, lines } = captureLogger();

    log.info({ password: 'hunter2', otp: '123456', email: 'a@b.com' });

    expect(lines[0]).toMatchObject({ password: '[REDACTED]', otp: '[REDACTED]', email: 'a@b.com' });
  });

  it('redacts secrets nested up to three levels deep', () => {
    const { log, lines } = captureLogger();

    log.info({
      body: { refreshToken: 'rt_abc', amount: '1000000' },
      req: { body: { newPassword: 'p@ss', handle: 'emma' } },
      payload: { user: { kyc: { bvn: '22212345678' } } },
    });

    expect(lines[0]).toMatchObject({
      body: { refreshToken: '[REDACTED]', amount: '1000000' },
      req: { body: { newPassword: '[REDACTED]', handle: 'emma' } },
      payload: { user: { kyc: { bvn: '[REDACTED]' } } },
    });
  });

  it('redacts authorization and cookie headers', () => {
    const { log, lines } = captureLogger();

    log.info({
      req: { headers: { authorization: 'Bearer eyJ...', cookie: 'sid=1', 'user-agent': 'curl' } },
      res: { headers: { 'set-cookie': 'sid=2' } },
    });

    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'user-agent': 'curl' } },
      res: { headers: { 'set-cookie': '[REDACTED]' } },
    });
  });

  it('never writes the secret value anywhere in the output', () => {
    const { log, lines } = captureLogger();

    log.info({ a: { b: { accessToken: 'tok_live_secret' } } });

    expect(JSON.stringify(lines)).not.toContain('tok_live_secret');
  });

  it('serializes errors with message and stack', () => {
    const { log, lines } = captureLogger();

    log.error({ err: new Error('boom') }, 'failed');

    expect(lines[0]).toMatchObject({ err: { type: 'Error', message: 'boom' } });
    expect(lines[0]?.err).toHaveProperty('stack');
  });

  it('respects the configured level', () => {
    const lines: unknown[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk);
        callback();
      },
    });
    const log = createLogger({ level: 'warn', pretty: false }, destination);

    log.info('hidden');
    log.warn('shown');

    expect(lines).toHaveLength(1);
  });
});

describe('logger', () => {
  it('is silent under test by default', () => {
    expect(logger.level).toBe('silent');
  });
});
