// The customer journey end to end, through the HTTP API only: register → verify → KYC →
// fund (provider webhook) → transfer → withdraw (payout webhook) → history, notifications,
// statement, and the books still balancing at the end.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../../src/modules/ledger/reconciliation.service.ts';
import { startE2e, type E2e } from '../helpers/e2e-app.ts';

interface Customer {
  id: string;
  handle: string;
  email: string;
  phone: string;
  token: string;
  walletId: string;
}

let e2e: E2e;
const users: Record<'ada' | 'bola', Customer> = {} as never;
const RUN = randomUUID().slice(0, 6);

const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, who?: Customer) => {
  const req = request(e2e.app)[method](`/api/v1${path}`);
  return who === undefined ? req : req.set('Authorization', `Bearer ${who.token}`);
};

/** What the provider would POST: the signed bytes of its webhook. */
async function deliver(providerReference: string) {
  const webhook = e2e.provider.settle(providerReference);
  let req = request(e2e.app).post('/api/v1/webhooks/payments');
  for (const [name, value] of Object.entries(webhook.headers)) req = req.set(name, String(value));
  const res = await req.send(webhook.rawBody.toString('utf8'));
  await e2e.drain();
  return res;
}

const providerReferenceOf = async (transactionId: string) =>
  (await e2e.db.payment.findUniqueOrThrow({ where: { transactionId } })).providerReference ?? '';

beforeAll(async () => {
  e2e = await startE2e();
}, 120_000);

afterAll(async () => {
  await e2e.close();
});

describe('a customer journey', () => {
  it('registers, verifies email and phone, and passes KYC Tier 1 (which opens a wallet)', async () => {
    for (const [name, digits] of [
      ['ada', '1111111'],
      ['bola', '2222222'],
    ] as const) {
      const handle = `${name}_${RUN}`;
      const email = `${handle}@fundra.dev`;
      const password = 'purple elephant 42 tall';
      const reg = await api('post', '/auth/register').send({
        email,
        phone: `0803${digits}`,
        handle,
        firstName: name === 'ada' ? 'Ada' : 'Bola',
        lastName: 'Test',
        password,
      });
      expect(reg.status).toBe(201);
      const login = await api('post', '/auth/login').send({ identifier: email, password });
      const customer = {
        id: (reg.body as { data: { user: { id: string; phone: string } } }).data.user.id,
        handle,
        email,
        phone: (reg.body as { data: { user: { phone: string } } }).data.user.phone,
        token: (login.body as { data: { accessToken: string } }).data.accessToken,
        walletId: '',
      };
      for (const [channel, to] of [
        ['email', customer.email],
        ['phone', customer.phone],
      ] as const) {
        expect((await api('post', `/auth/verify/${channel}/request`, customer)).status).toBe(202);
        const code = e2e.messages.lastCodeTo(to);
        expect(
          (await api('post', `/auth/verify/${channel}/confirm`, customer).send({ code })).status,
        ).toBe(200);
      }
      const kyc = await api('post', '/kyc/tier-1', customer).send({ dateOfBirth: '1990-01-01' });
      expect(kyc.status).toBe(200);
      const wallets = await api('get', '/wallets', customer);
      customer.walletId =
        (wallets.body as { data: { wallets: { id: string }[] } }).data.wallets[0]?.id ?? '';
      expect(customer.walletId).not.toBe('');
      users[name] = customer;
    }
  });

  it('funds the wallet: deposit, checkout, and only the signed webhook credits it', async () => {
    const ada = users.ada;
    const deposit = await api('post', '/payments/deposits', ada)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '2000000', currency: 'NGN' });
    expect(deposit.status).toBe(201);
    const body = deposit.body as {
      data: { deposit: { id: string; status: string }; checkoutUrl: string };
    };
    expect(body.data.deposit.status).toBe('PROCESSING');
    expect(body.data.checkoutUrl).toMatch(/^https:\/\//);

    const before = await api('get', `/wallets/${ada.walletId}`, ada);
    expect(
      (before.body as { data: { wallet: { balance: { ledger: string } } } }).data.wallet.balance
        .ledger,
    ).toBe('0');

    expect((await deliver(await providerReferenceOf(body.data.deposit.id))).status).toBe(200);
    const after = await api('get', `/transactions/${body.data.deposit.id}`, ada);
    expect(
      (after.body as { data: { transaction: { status: string } } }).data.transaction.status,
    ).toBe('COMPLETED');
  });

  it('sends money to another user, and a retry with the same key moves nothing again', async () => {
    const key = randomUUID();
    const send = () =>
      api('post', '/transfers', users.ada).set('Idempotency-Key', key).send({
        recipientHandle: users.bola.handle,
        amount: '500000',
        currency: 'NGN',
        description: 'Lunch',
      });
    const first = await send();
    expect(first.status).toBe(201);
    const replay = await send();
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      await e2e.db.transaction.count({
        where: { type: 'TRANSFER', sourceWalletId: users.ada.walletId },
      }),
    ).toBe(1);
  });

  it('withdraws to a bank: name enquiry, held at once, completed by the payout webhook', async () => {
    const ada = users.ada;
    const name = await api(
      'get',
      '/payments/bank-accounts/resolve?bankCode=058&accountNumber=0123456789',
      ada,
    );
    expect(
      (name.body as { data: { account: { accountName: string } } }).data.account.accountName,
    ).toBe('MOCK ACCOUNT 6789');

    const withdrawal = await api('post', '/payments/withdrawals', ada)
      .set('Idempotency-Key', randomUUID())
      .send({ bankCode: '058', accountNumber: '0123456789', amount: '300000', currency: 'NGN' });
    expect(withdrawal.status).toBe(201);
    const id = (withdrawal.body as { data: { withdrawal: { id: string } } }).data.withdrawal.id;
    const held = await e2e.db.wallet.findUniqueOrThrow({ where: { id: ada.walletId } });
    expect(held.availableBalance).toBe(1_199_000n); // 20,000 − 5,000 − 3,000 − ₦10 fee, held
    expect(held.ledgerBalance).toBe(1_500_000n);

    await deliver(await providerReferenceOf(id));
    const done = await e2e.db.wallet.findUniqueOrThrow({ where: { id: ada.walletId } });
    expect(done.ledgerBalance).toBe(1_199_000n);
    expect(done.availableBalance).toBe(1_199_000n);
  });

  it('shows each side its own history, newest first, with running balances', async () => {
    const ada = (await api('get', '/transactions', users.ada)).body as {
      data: {
        transactions: {
          type: string;
          direction: string;
          total: string;
          balanceAfter: string | null;
        }[];
      };
    };
    expect(
      ada.data.transactions.map(
        (t) => `${t.type} ${t.direction} ${t.total} ${String(t.balanceAfter)}`,
      ),
    ).toEqual([
      'WITHDRAWAL OUT 301000 1199000',
      'TRANSFER OUT 500000 1500000',
      'DEPOSIT IN 2000000 2000000',
    ]);
    const bola = (await api('get', '/transactions', users.bola)).body as {
      data: { transactions: { type: string; direction: string; amount: string }[] };
    };
    expect(bola.data.transactions).toHaveLength(1);
    expect(bola.data.transactions[0]).toMatchObject({
      type: 'TRANSFER',
      direction: 'IN',
      amount: '500000',
    });
  });

  it('notifies both people, in the app and by email', async () => {
    await e2e.drain();
    const titles = async (who: Customer) =>
      (
        (await api('get', '/notifications', who)).body as {
          data: { notifications: { title: string }[] };
        }
      ).data.notifications.map((n) => n.title);
    expect(await titles(users.ada)).toEqual(
      expect.arrayContaining([
        'Wallet funded',
        'Money sent',
        'Withdrawal sent',
        'Verification approved',
      ]),
    );
    expect(await titles(users.bola)).toContain('Money in');
    expect(
      e2e.channels.sent.some(
        (m) => m.channel === 'EMAIL' && m.to === users.ada.email && m.subject === 'Withdrawal sent',
      ),
    ).toBe(true);
  });

  it('produces a statement from the ledger that matches the history', async () => {
    const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    const requested = await api('post', '/statements', users.ada).send({
      walletId: users.ada.walletId,
      from: today,
      to: today,
    });
    expect(requested.status).toBe(202);
    await e2e.drain();
    const id = (requested.body as { data: { statement: { id: string } } }).data.statement.id;
    const file = await api('get', `/statements/${id}/download`, users.ada);
    expect(file.status).toBe(200);
    const lines = file.text.split('\r\n');
    expect(lines).toContain('Closing balance,11990.00');
    expect(lines.filter((l) => /,(DEPOSIT|TRANSFER|WITHDRAWAL),/.test(l))).toHaveLength(3);
  });

  it('leaves the books balanced and every wallet in agreement with its ledger', async () => {
    const report = await new ReconciliationService(e2e.db).run();
    expect(report.ok).toBe(true);
    expect(report.wallets.drifted).toEqual([]);
    expect(report.ledger.balanced).toBe(true);
  });
});
