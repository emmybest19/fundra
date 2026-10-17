// What each outbox event tells whom (docs/ARCHITECTURE.md §9.3). Payloads carry IDs and facts
// only; names, amounts and destinations are loaded here, when the notification is made. Text
// never contains a full account number, a freeze reason or anything secret.
import { formatMinor, isCurrency } from '../../common/constants/currency.ts';
import type { OutboxJobData } from '../../common/outbox/outbox.relay.ts';
import type { OutboxEventPayloads, OutboxEventType } from '../../common/outbox/outbox.types.ts';
import type { PrismaClient } from '../../generated/prisma/client.ts';
import type { NotificationInput } from './notification.types.ts';

type Db = Pick<PrismaClient, 'user' | 'transaction' | 'payment'>;
type Note = Omit<NotificationInput, 'sourceEventId'>;

const money = (amount: string, currency: string): string =>
  isCurrency(currency) ? formatMinor(BigInt(amount), currency) : `${amount} ${currency}`;

async function nameOf(db: Db, userId: string): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, handle: true },
  });
  return user === null ? 'a Fundra user' : `${user.firstName} ${user.lastName} (@${user.handle})`;
}

async function transactionOf(db: Db, id: string) {
  return db.transaction.findUnique({
    where: { id },
    select: { amount: true, fee: true, currency: true, reference: true },
  });
}

type Mapper<T extends OutboxEventType> = (
  db: Db,
  payload: OutboxEventPayloads[T],
) => Promise<Note[]>;

const MAPPERS: { [T in OutboxEventType]?: Mapper<T> } = {
  'transfer.completed': async (db, p) => {
    const amount = money(p.amount, p.currency);
    const fee = p.fee === '0' ? '' : ` (fee ${money(p.fee, p.currency)})`;
    const data = { transactionId: p.transactionId, reference: p.reference, amount: p.amount };
    return [
      {
        userId: p.senderUserId,
        type: 'transfer.sent',
        category: 'transactions',
        title: 'Money sent',
        body: `You sent ${amount} to ${await nameOf(db, p.recipientUserId)}${fee}. Ref ${p.reference}.`,
        data,
      },
      {
        userId: p.recipientUserId,
        type: 'transfer.received',
        category: 'transactions',
        title: 'Money in',
        body: `You received ${amount} from ${await nameOf(db, p.senderUserId)}. Ref ${p.reference}.`,
        data,
      },
    ];
  },

  'transaction.reversed': async (db, p) => {
    const amount = money(p.amount, p.currency);
    const fee = p.fee === '0' ? '' : `, plus the ${money(p.fee, p.currency)} fee`;
    const data = {
      transactionId: p.originalTransactionId,
      reference: p.reference,
      amount: p.amount,
    };
    return [
      {
        userId: p.senderUserId,
        type: 'transfer.reversed',
        category: 'transactions',
        title: 'Transfer reversed',
        body: `Your transfer ${p.reference} was reversed: ${amount}${fee} is back in your wallet.`,
        data,
      },
      {
        userId: p.recipientUserId,
        type: 'transfer.reversed',
        category: 'transactions',
        title: 'Transfer reversed',
        body: `A transfer of ${amount} from ${await nameOf(db, p.senderUserId)} (${p.reference}) was reversed and taken back from your wallet.`,
        data,
      },
    ];
  },

  'deposit.completed': (_db, p) =>
    Promise.resolve([
      {
        userId: p.userId,
        type: 'deposit.completed',
        category: 'transactions',
        title: 'Wallet funded',
        body: `${money(p.amount, p.currency)} has been added to your wallet. Ref ${p.reference}.`,
        data: { transactionId: p.transactionId, reference: p.reference, amount: p.amount },
      },
    ]),

  'deposit.failed': async (db, p) => {
    const tx = await transactionOf(db, p.transactionId);
    const what =
      tx === null ? 'Your deposit' : `Your deposit of ${money(tx.amount.toString(), tx.currency)}`;
    return [
      {
        userId: p.userId,
        type: 'deposit.failed',
        category: 'transactions',
        title: 'Deposit unsuccessful',
        body: `${what} (${p.reference}) didn't go through: ${p.reason} Nothing was added to your wallet.`,
        data: { transactionId: p.transactionId, reference: p.reference },
      },
    ];
  },

  'withdrawal.completed': (_db, p) => {
    const fee = p.fee === '0' ? '' : ` (fee ${money(p.fee, p.currency)})`;
    return Promise.resolve([
      {
        userId: p.userId,
        type: 'withdrawal.completed',
        category: 'transactions',
        title: 'Withdrawal sent',
        body: `${money(p.amount, p.currency)} has been sent to your bank account${fee}. Ref ${p.reference}.`,
        data: { transactionId: p.transactionId, reference: p.reference, amount: p.amount },
      },
    ]);
  },

  'withdrawal.failed': async (db, p) => {
    const tx = await transactionOf(db, p.transactionId);
    const what =
      tx === null
        ? 'Your withdrawal'
        : `Your withdrawal of ${money(tx.amount.toString(), tx.currency)}`;
    return [
      {
        userId: p.userId,
        type: 'withdrawal.failed',
        category: 'transactions',
        title: 'Withdrawal failed',
        body: `${what} (${p.reference}) failed: ${p.reason} The money is back in your wallet.`,
        data: { transactionId: p.transactionId, reference: p.reference },
      },
    ];
  },

  'payment.completed': async (db, p) => [
    {
      userId: p.userId,
      type: 'payment.completed',
      category: 'transactions',
      title: 'Payment successful',
      body: `You paid ${money(p.amount, p.currency)} to ${await billerOf(db, p.transactionId)}. Ref ${p.reference}.`,
      data: { transactionId: p.transactionId, reference: p.reference, amount: p.amount },
    },
  ],

  'payment.failed': async (db, p) => [
    {
      userId: p.userId,
      type: 'payment.failed',
      category: 'transactions',
      title: 'Payment failed',
      body: `Your payment to ${await billerOf(db, p.transactionId)} (${p.reference}) failed: ${p.reason} The money is back in your wallet.`,
      data: { transactionId: p.transactionId, reference: p.reference },
    },
  ],

  'payment.refunded': async (db, p) => [
    {
      userId: p.userId,
      type: 'payment.refunded',
      category: 'transactions',
      title: 'Refund received',
      body: `${money(p.amount, p.currency)} was refunded for your payment to ${await billerOf(db, p.refundOf)}.`,
      data: { transactionId: p.transactionId, refundOf: p.refundOf, amount: p.amount },
    },
  ],

  'kyc.status_changed': (_db, p) => {
    const tier = `Tier ${String(p.tier)}`;
    const text = {
      APPROVED: {
        title: 'Verification approved',
        body: `You're now verified at ${tier}. Your new limits apply at once.`,
      },
      REJECTED: {
        title: 'Verification unsuccessful',
        body: `Your ${tier} verification wasn't approved. Open the app to see why and try again.`,
      },
      PENDING: {
        title: 'Verification submitted',
        body: `We've received your ${tier} verification and will review it shortly.`,
      },
      IN_REVIEW: {
        title: 'Verification in review',
        body: `Your ${tier} verification is being reviewed.`,
      },
    }[p.status];
    return Promise.resolve([
      {
        userId: p.userId,
        type: 'kyc.status_changed',
        category: 'security',
        ...text,
        data: { status: p.status, tier: p.tier },
      },
    ]);
  },

  // Only a new device is worth an alert: every sign-in would be noise.
  'auth.login_succeeded': (_db, p) =>
    Promise.resolve(
      p.newDevice
        ? [
            {
              userId: p.userId,
              type: 'auth.new_device',
              category: 'security',
              title: 'New sign-in',
              body: "A new device signed in to your account. If this wasn't you, change your password now.",
              data: { sessionId: p.sessionId },
            },
          ]
        : [],
    ),

  // The email went out directly when it happened; these are the other channels.
  'auth.password_changed': (_db, p) =>
    Promise.resolve([
      {
        userId: p.userId,
        type: 'auth.password_changed',
        category: 'security',
        title: 'Password changed',
        body: "Your password was changed and your other devices were signed out. If this wasn't you, reset your password now.",
        excludeChannels: ['EMAIL'],
      },
    ]),

  // The old address or number was alerted directly; this reaches the account as it is now.
  'user.contact_changed': (_db, p) =>
    Promise.resolve([
      {
        userId: p.userId,
        type: 'user.contact_changed',
        category: 'security',
        title: p.changed === 'email' ? 'Email address changed' : 'Phone number changed',
        body: `Your ${p.changed === 'email' ? 'email address' : 'phone number'} was changed. If this wasn't you, contact support now.`,
        data: { changed: p.changed },
      },
    ]),

  // Never the reason (it stays in the audit log: no tipping off).
  'wallet.status_changed': (_db, p) => {
    const text = {
      FROZEN: {
        title: 'Wallet restricted',
        body: 'Your wallet has been restricted. Contact support for help.',
      },
      ACTIVE: { title: 'Wallet active', body: 'Your wallet is active again.' },
      CLOSED: { title: 'Wallet closed', body: 'Your wallet has been closed.' },
    }[p.status];
    return Promise.resolve([
      {
        userId: p.userId,
        type: 'wallet.status_changed',
        category: 'security',
        ...text,
        data: { status: p.status },
      },
    ]);
  },

  'statement.ready': (_db, p) =>
    Promise.resolve([
      {
        userId: p.userId,
        type: 'statement.ready',
        category: 'transactions',
        title: 'Statement ready',
        body: `Your statement for ${p.periodStart} to ${p.periodEnd} is ready to download.`,
        data: { statementId: p.statementId },
      },
    ]),

  // user.deactivated: the owner was emailed directly; the account no longer receives anything.
};

async function billerOf(db: Db, transactionId: string): Promise<string> {
  const payment = await db.payment.findUnique({
    where: { transactionId },
    select: { metadata: true },
  });
  const meta = payment?.metadata;
  const bill =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta.bill : undefined;
  if (typeof bill === 'object' && bill !== null && !Array.isArray(bill)) {
    const { billerName, customerReference } = bill;
    if (typeof billerName === 'string' && typeof customerReference === 'string') {
      return `${billerName} (${customerReference})`;
    }
  }
  return 'the biller';
}

/** The notifications an outbox event produces; none for events nobody needs telling about. */
export async function notificationsForEvent(
  db: Db,
  event: OutboxJobData,
): Promise<NotificationInput[]> {
  const mapper = MAPPERS[event.eventType as OutboxEventType] as Mapper<OutboxEventType> | undefined;
  if (mapper === undefined) return [];
  const notes = await mapper(db, event.payload as OutboxEventPayloads[OutboxEventType]);
  return notes.map((note) => ({ ...note, sourceEventId: event.outboxEventId }));
}
