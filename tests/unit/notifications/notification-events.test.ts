import { describe, expect, it } from 'vitest';
import type { OutboxJobData } from '../../../src/common/outbox/outbox.relay.ts';
import type { PrismaClient } from '../../../src/generated/prisma/client.ts';
import { notificationsForEvent } from '../../../src/modules/notifications/notification.events.ts';

const ADA = 'user-ada';
const BOLA = 'user-bola';

const db = {
  user: {
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === ADA
          ? { firstName: 'Ada', lastName: 'Okafor', handle: 'ada' }
          : where.id === BOLA
            ? { firstName: 'Bola', lastName: 'Adeyemi', handle: 'bola' }
            : null,
      ),
  },
  transaction: {
    findUnique: () =>
      Promise.resolve({ amount: 250_000n, fee: 1_000n, currency: 'NGN', reference: 'FND-TRX-1' }),
  },
  payment: {
    findUnique: () =>
      Promise.resolve({
        metadata: { bill: { billerName: 'DStv', customerReference: '1234567890' } },
      }),
  },
} as unknown as PrismaClient;

function event(eventType: string, payload: unknown): OutboxJobData {
  return {
    outboxEventId: 'evt-1',
    eventType,
    aggregate: { type: 'x', id: 'y' },
    payload,
    createdAt: '2026-10-15T10:00:00.000Z',
  };
}

describe('notificationsForEvent', () => {
  it('transfer.completed tells the sender and the recipient, each about the other', async () => {
    const notes = await notificationsForEvent(
      db,
      event('transfer.completed', {
        transactionId: 't1',
        reference: 'FND-TRX-1',
        senderUserId: ADA,
        recipientUserId: BOLA,
        amount: '1000000',
        fee: '0',
        currency: 'NGN',
      }),
    );

    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      userId: ADA,
      type: 'transfer.sent',
      category: 'transactions',
      body: 'You sent ₦10,000.00 to Bola Adeyemi (@bola). Ref FND-TRX-1.',
      sourceEventId: 'evt-1',
    });
    expect(notes[1]).toMatchObject({
      userId: BOLA,
      type: 'transfer.received',
      body: 'You received ₦10,000.00 from Ada Okafor (@ada). Ref FND-TRX-1.',
    });
  });

  it('mentions a fee only when there was one', async () => {
    const [sent] = await notificationsForEvent(
      db,
      event('transfer.completed', {
        transactionId: 't1',
        reference: 'R',
        senderUserId: ADA,
        recipientUserId: BOLA,
        amount: '100',
        fee: '50',
        currency: 'NGN',
      }),
    );
    expect(sent?.body).toContain('(fee ₦0.50)');
  });

  it('transaction.reversed tells both sides; the recipient learns the money was taken back', async () => {
    const notes = await notificationsForEvent(
      db,
      event('transaction.reversed', {
        originalTransactionId: 't1',
        reversalTransactionId: 't2',
        feeRefundTransactionId: null,
        reference: 'R',
        senderUserId: ADA,
        recipientUserId: BOLA,
        amount: '1000000',
        fee: '0',
        currency: 'NGN',
      }),
    );
    expect(notes.map((n) => n.userId)).toEqual([ADA, BOLA]);
    expect(notes[1]?.body).toMatch(/taken back from your wallet/);
  });

  it('deposits, withdrawals and payments go to their owner, with amounts and outcomes', async () => {
    const owner = { userId: ADA, transactionId: 't1', reference: 'R' };
    const cases: [string, unknown, RegExp][] = [
      [
        'deposit.completed',
        { ...owner, amount: '500000', currency: 'NGN' },
        /₦5,000.00 has been added/,
      ],
      [
        'deposit.failed',
        { ...owner, reason: 'The card was declined.' },
        /₦2,500.00 \(R\) didn't go through: The card was declined\. Nothing was added/,
      ],
      [
        'withdrawal.completed',
        { ...owner, amount: '250000', fee: '1000', currency: 'NGN' },
        /₦2,500.00 has been sent to your bank account \(fee ₦10.00\)/,
      ],
      ['withdrawal.failed', { ...owner, reason: 'The bank is offline.' }, /back in your wallet/],
      [
        'payment.completed',
        { ...owner, amount: '150000', fee: '0', currency: 'NGN' },
        /You paid ₦1,500.00 to DStv \(1234567890\)/,
      ],
      [
        'payment.failed',
        { ...owner, reason: 'No answer.' },
        /payment to DStv \(1234567890\) \(R\) failed/,
      ],
      [
        'payment.refunded',
        { ...owner, refundOf: 'p1', amount: '50000', currency: 'NGN' },
        /₦500.00 was refunded for your payment to DStv/,
      ],
    ];
    for (const [type, payload, body] of cases) {
      const notes = await notificationsForEvent(db, event(type, payload));
      expect(notes, type).toHaveLength(1);
      expect(notes[0]?.userId, type).toBe(ADA);
      expect(notes[0]?.category, type).toBe('transactions');
      expect(notes[0]?.body, type).toMatch(body);
    }
  });

  it('KYC changes are security notifications naming the tier', async () => {
    const [approved] = await notificationsForEvent(
      db,
      event('kyc.status_changed', { userId: ADA, status: 'APPROVED', tier: 2 }),
    );
    expect(approved).toMatchObject({ category: 'security', title: 'Verification approved' });
    expect(approved?.body).toContain('Tier 2');
  });

  it('a sign-in alerts only from a new device', async () => {
    const login = (newDevice: boolean) =>
      notificationsForEvent(
        db,
        event('auth.login_succeeded', { userId: ADA, sessionId: 's', newDevice }),
      );
    expect(await login(false)).toEqual([]);
    expect(await login(true)).toMatchObject([{ type: 'auth.new_device', category: 'security' }]);
  });

  it('a password change skips email (sent directly when it happened)', async () => {
    const [note] = await notificationsForEvent(db, event('auth.password_changed', { userId: ADA }));
    expect(note?.excludeChannels).toEqual(['EMAIL']);
  });

  it('a frozen wallet never says why (no tipping off)', async () => {
    const [note] = await notificationsForEvent(
      db,
      event('wallet.status_changed', { userId: ADA, walletId: 'w', status: 'FROZEN' }),
    );
    expect(note?.title).toBe('Wallet restricted');
    expect(note?.body).not.toMatch(/fraud|suspicious|investigat|reason/i);
  });

  it('nothing for a deactivated account, or for events nobody needs telling about', async () => {
    expect(
      await notificationsForEvent(db, event('user.deactivated', { userId: ADA, walletsClosed: 1 })),
    ).toEqual([]);
    expect(await notificationsForEvent(db, event('something.internal', {}))).toEqual([]);
  });

  it('falls back politely when a name or biller is missing', async () => {
    const [sent] = await notificationsForEvent(
      db,
      event('transfer.completed', {
        transactionId: 't1',
        reference: 'R',
        senderUserId: ADA,
        recipientUserId: 'gone',
        amount: '100',
        fee: '0',
        currency: 'NGN',
      }),
    );
    expect(sent?.body).toContain('to a Fundra user');
  });
});
