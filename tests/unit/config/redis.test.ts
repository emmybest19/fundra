import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { checkRedis, disconnectRedis } from '../../../src/config/redis.ts';

// Real-server behaviour is covered by integration tests (Testcontainers, Stage 6).

describe('checkRedis', () => {
  it('resolves when Redis answers PONG', async () => {
    await expect(checkRedis({ ping: vi.fn().mockResolvedValue('PONG') })).resolves.toBeUndefined();
  });

  it('rejects on an error reply such as LOADING (Redis still restoring data)', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('LOADING Redis is loading the dataset'));

    await expect(checkRedis({ ping })).rejects.toThrow('LOADING');
  });

  it('rejects when the command fails (e.g. Redis unreachable)', async () => {
    const ping = vi.fn().mockRejectedValue(new Error("Stream isn't writeable"));

    await expect(checkRedis({ ping })).rejects.toThrow("Stream isn't writeable");
  });
});

function fakeClient(status: Redis['status'], quit = vi.fn().mockResolvedValue('OK')) {
  return { status, quit, disconnect: vi.fn() };
}

describe('disconnectRedis', () => {
  it('quits gracefully when connected', async () => {
    const client = fakeClient('ready');

    await disconnectRedis(client);

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('falls back to a hard disconnect if QUIT fails', async () => {
    const client = fakeClient('ready', vi.fn().mockRejectedValue(new Error('connection lost')));

    await disconnectRedis(client);

    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it.each<Redis['status']>(['reconnecting', 'connecting', 'wait'])(
    'hard-disconnects while %s, which also stops the reconnect loop',
    async (status) => {
      const client = fakeClient(status);

      await disconnectRedis(client);

      expect(client.quit).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalledOnce();
    },
  );

  it('does nothing if already closed', async () => {
    const client = fakeClient('end');

    await disconnectRedis(client);

    expect(client.quit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});
