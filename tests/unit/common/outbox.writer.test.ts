import { describe, expect, it, vi } from 'vitest';
import type { OutboxEvent } from '../../../src/common/outbox/outbox.types.ts';
import {
  MAX_OUTBOX_PAYLOAD_BYTES,
  writeOutboxEvent,
  type OutboxWriter,
} from '../../../src/common/outbox/outbox.writer.ts';

function fakeTx() {
  const create = vi.fn().mockResolvedValue({ id: 'evt-1' });
  return { tx: { outboxEvent: { create } } as unknown as OutboxWriter, create };
}

const transferCompleted: OutboxEvent<'transfer.completed'> = {
  type: 'transfer.completed',
  aggregate: { type: 'transaction', id: 'txn-1' },
  payload: {
    transactionId: 'txn-1',
    reference: 'FND-TRX-20261002-8F92A1',
    senderUserId: 'user-a',
    recipientUserId: 'user-b',
    amount: '1000000',
    fee: '0',
    currency: 'NGN',
  },
};

describe('writeOutboxEvent', () => {
  it('inserts the event through the given transaction and returns its ID', async () => {
    const { tx, create } = fakeTx();

    await expect(writeOutboxEvent(tx, transferCompleted)).resolves.toBe('evt-1');
    expect(create).toHaveBeenCalledWith({
      data: {
        eventType: 'transfer.completed',
        aggregateType: 'transaction',
        aggregateId: 'txn-1',
        payload: transferCompleted.payload,
      },
      select: { id: true },
    });
  });

  it('refuses oversized payloads before touching the database', async () => {
    const { tx, create } = fakeTx();
    const huge: OutboxEvent<'transfer.failed'> = {
      type: 'transfer.failed',
      aggregate: { type: 'transaction', id: 'txn-1' },
      payload: {
        transactionId: 'txn-1',
        reference: 'FND-TRX-20261002-8F92A1',
        senderUserId: 'user-a',
        reason: 'x'.repeat(MAX_OUTBOX_PAYLOAD_BYTES),
      },
    };

    await expect(writeOutboxEvent(tx, huge)).rejects.toThrow('Send identifiers, not documents');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses payloads that are not JSON-safe (e.g. bigint) before touching the database', async () => {
    const { tx, create } = fakeTx();
    const event = {
      ...transferCompleted,
      payload: { ...transferCompleted.payload, amount: 1_000_000n },
    } as unknown as OutboxEvent<'transfer.completed'>;

    await expect(writeOutboxEvent(tx, event)).rejects.toThrow(/BigInt/);
    expect(create).not.toHaveBeenCalled();
  });

  it('propagates database errors so the business action rolls back too', async () => {
    const tx = {
      outboxEvent: { create: vi.fn().mockRejectedValue(new Error('connection lost')) },
    } as unknown as OutboxWriter;

    await expect(writeOutboxEvent(tx, transferCompleted)).rejects.toThrow('connection lost');
  });

  it('rejects unknown event types and mismatched payloads at compile time', () => {
    const events = [
      // @ts-expect-error -- unknown event type
      { type: 'transfer.complete', aggregate: { type: 't', id: '1' }, payload: {} },
      {
        type: 'transfer.completed',
        aggregate: { type: 'transaction', id: 'txn-1' },
        // @ts-expect-error -- payload missing required fields (amount, currency, ...)
        payload: { transactionId: 'txn-1' },
      },
      {
        ...transferCompleted,
        // @ts-expect-error -- amounts are strings, never numbers or bigint
        payload: { ...transferCompleted.payload, amount: 1_000_000 },
      },
    ] satisfies OutboxEvent<'transfer.completed'>[];
    expect(events).toHaveLength(3);
  });
});
