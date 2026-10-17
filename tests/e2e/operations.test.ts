// Staff and money operations end to end: KYC review, admin actions, bill payments and refunds,
// a failed payout, beneficiaries and webhook security. HTTP API on in-process PostgreSQL.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_ACCOUNT_NUMBERS } from '../../src/modules/payments/providers/mock-payment-provider.ts';
import { startE2e, type Customer, type E2e } from '../helpers/e2e-app.ts';

let e2e: E2e;
let compliance: Customer;
let finance: Customer;
let root: Customer;
const code = (res: { body: unknown }) => (res.body as { error?: { code?: string } }).error?.code;
// T names the response shape expected at each call site; that single use is the point.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const data = <T>(res: { body: unknown }) => (res.body as { data: T }).data;
const PNG = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Buffer.from('png body'),
]);
const PDF = Buffer.from('%PDF-1.7\nutility bill');
const pay = (path: string, who: Customer, body: object) =>
  e2e.api('post', path, who).set('Idempotency-Key', randomUUID()).send(body);
const balanceOf = async (who: Customer) =>
  (await e2e.db.wallet.findUniqueOrThrow({ where: { id: who.walletId } })).ledgerBalance;

beforeAll(async () => {
  e2e = await startE2e();
  compliance = await e2e.signUp('compliance', { role: 'COMPLIANCE' });
  finance = await e2e.signUp('finance', { role: 'FINANCE' });
  root = await e2e.signUp('root', { role: 'SUPER_ADMIN' });
}, 120_000);

afterAll(async () => {
  await e2e.close();
});

describe('KYC review', () => {
  it('Tier 2 by BVN, then Tier 3 documents reviewed and approved by compliance', async () => {
    const ada = await e2e.signUp('ada');
    expect(
      (await e2e.api('post', '/kyc/tier-2', ada).send({ type: 'BVN', idNumber: '22212345678' }))
        .status,
    ).toBe(200);
    for (const [type, mime, body] of [
      ['PASSPORT', 'image/png', PNG],
      ['UTILITY_BILL', 'application/pdf', PDF],
    ] as const) {
      const up = await e2e
        .api('put', `/kyc/documents/${type}`, ada)
        .set('Content-Type', mime)
        .send(body);
      expect(up.status).toBeLessThan(300);
    }
    const submitted = await e2e
      .api('post', '/kyc/tier-3', ada)
      .send({ address: { line1: '1 Marina', city: 'Lagos', state: 'Lagos' } });
    expect(submitted.status).toBeLessThan(300);

    const queue = data<{ profiles: { profileId: string; user: { id: string } }[] }>(
      await e2e.api('get', '/admin/kyc', compliance),
    );
    const profileId = queue.profiles.find((p) => p.user.id === ada.id)?.profileId ?? '';
    expect((await e2e.api('post', `/admin/kyc/${profileId}/review`, compliance)).status).toBe(200);
    const approved = await e2e.api('post', `/admin/kyc/${profileId}/approve`, compliance);
    expect(data<{ kyc: { tier: number } }>(approved).kyc.tier).toBe(3);
    expect(data<{ kyc: { tier: number } }>(await e2e.api('get', '/kyc', ada)).kyc.tier).toBe(3);
  });

  it('a rejected Tier 3 tells the user why; nobody reviews their own case', async () => {
    const bola = await e2e.signUp('bola');
    await e2e.api('post', '/kyc/tier-2', bola).send({ type: 'NIN', idNumber: '33312345678' });
    await e2e
      .api('put', '/kyc/documents/PASSPORT', bola)
      .set('Content-Type', 'image/png')
      .send(PNG);
    await e2e
      .api('put', '/kyc/documents/UTILITY_BILL', bola)
      .set('Content-Type', 'application/pdf')
      .send(PDF);
    await e2e
      .api('post', '/kyc/tier-3', bola)
      .send({ address: { line1: '2 Allen', city: 'Ikeja', state: 'Lagos' } });
    const profileId = (await e2e.db.kycProfile.findUniqueOrThrow({ where: { userId: bola.id } }))
      .id;
    await e2e.api('post', `/admin/kyc/${profileId}/review`, compliance);
    const rejected = await e2e
      .api('post', `/admin/kyc/${profileId}/reject`, compliance)
      .send({ reason: 'The passport photo is blurred.' });
    expect(rejected.status).toBe(200);
    expect(JSON.stringify((await e2e.api('get', '/kyc', bola)).body)).toContain(
      'The passport photo is blurred.',
    );

    const ownProfile = (
      await e2e.db.kycProfile.findUniqueOrThrow({ where: { userId: compliance.id } })
    ).id;
    expect(code(await e2e.api('post', `/admin/kyc/${ownProfile}/approve`, compliance))).toBe(
      'KYC_SELF_REVIEW',
    );
  });
});

describe('admin operations', () => {
  it('suspends and reactivates a customer; their tokens stop and start working', async () => {
    const chidi = await e2e.signUp('chidi');
    const suspended = await e2e
      .api('post', `/admin/users/${chidi.id}/suspend`, compliance)
      .send({ reason: 'Fraud report' });
    expect(data<{ user: { status: string } }>(suspended).user.status).toBe('SUSPENDED');
    expect((await e2e.api('get', '/users/me', chidi)).status).toBe(401);
    const back = await e2e
      .api('post', `/admin/users/${chidi.id}/reactivate`, compliance)
      .send({ reason: 'Cleared' });
    expect(data<{ user: { status: string } }>(back).user.status).toBe('ACTIVE');
    const listed = data<{ users: { id: string }[] }>(
      await e2e.api('get', `/admin/users?q=${chidi.handle}`, compliance),
    );
    expect(listed.users.map((u) => u.id)).toEqual([chidi.id]);
    expect((await e2e.api('get', `/admin/users/${chidi.id}`, compliance)).status).toBe(200);
  });

  it('grants and revokes a role, effective on the next request', async () => {
    const dayo = await e2e.signUp('dayo');
    expect((await e2e.api('get', '/admin/transactions', dayo)).status).toBe(403);
    await e2e.api('post', `/admin/users/${dayo.id}/roles`, root).send({ role: 'SUPPORT' });
    expect((await e2e.api('get', '/admin/transactions', dayo)).status).toBe(200);
    await e2e.api('delete', `/admin/users/${dayo.id}/roles/SUPPORT`, root);
    expect((await e2e.api('get', '/admin/transactions', dayo)).status).toBe(403);
    expect(
      data<{ roles: unknown[] }>(await e2e.api('get', '/admin/roles', root)).roles.length,
    ).toBeGreaterThan(0);
  });

  it('reverses a transfer, freezes a wallet, and a new fee applies to the next transfer', async () => {
    const eze = await e2e.signUp('eze');
    const fola = await e2e.signUp('fola');
    await e2e.fund(eze, 1_000_000n);
    const sent = await pay('/transfers', eze, {
      recipientHandle: fola.handle,
      amount: '200000',
      currency: 'NGN',
    });
    const transferId = data<{ transfer: { id: string } }>(sent).transfer.id;
    expect((await e2e.api('get', `/admin/transactions/${transferId}`, finance)).status).toBe(200);
    expect(
      (
        await e2e
          .api('post', `/admin/transactions/${transferId}/reverse`, finance)
          .send({ reason: 'Wrong person' })
      ).status,
    ).toBe(200);
    expect(await balanceOf(eze)).toBe(1_000_000n);
    expect(await balanceOf(fola)).toBe(0n);

    await e2e
      .api('post', `/admin/wallets/${eze.walletId}/freeze`, compliance)
      .send({ reason: 'AML hold' });
    expect(
      code(
        await pay('/transfers', eze, {
          recipientHandle: fola.handle,
          amount: '100',
          currency: 'NGN',
        }),
      ),
    ).toBe('WALLET_FROZEN');
    await e2e
      .api('post', `/admin/wallets/${eze.walletId}/unfreeze`, compliance)
      .send({ reason: 'Cleared' });
    expect((await e2e.api('get', `/admin/wallets/${eze.walletId}`, finance)).status).toBe(200);

    expect(
      (
        await e2e
          .api('put', '/admin/settings/fee-rules/TRANSFER/NGN', root)
          .send({ flatFee: '2500', percentageBps: 0 })
      ).status,
    ).toBe(200);
    const charged = await pay('/transfers', eze, {
      recipientHandle: fola.handle,
      amount: '100000',
      currency: 'NGN',
    });
    expect(data<{ transfer: { fee: string } }>(charged).transfer.fee).toBe('2500');
    await e2e
      .api('put', '/admin/settings/fee-rules/TRANSFER/NGN', root)
      .send({ flatFee: '0', percentageBps: 0 });
    expect(
      (
        await e2e.api('put', '/admin/settings/tier-limits/1/NGN', root).send({
          perTransactionLimit: '5000000',
          dailyOutflowLimit: '5000000',
          maxBalance: '30000000',
        })
      ).status,
    ).toBe(200);
    expect((await e2e.api('get', '/admin/settings', finance)).status).toBe(200);
  });

  it('reads the audit trail, webhooks and a clean reconciliation report', async () => {
    const audit = data<{ auditLogs: { action: string }[] }>(
      await e2e.api('get', '/admin/audit-logs?action=user.suspended', compliance),
    );
    expect(audit.auditLogs.length).toBe(1);
    expect((await e2e.api('get', '/admin/webhooks', finance)).status).toBe(200);
    expect(
      data<{ report: { ok: boolean } }>(await e2e.api('get', '/admin/reconciliation', finance))
        .report.ok,
    ).toBe(true);
  });
});

describe('payments beyond the happy path', () => {
  it('pays a bill, then the biller refunds part of it as its own REFUND', async () => {
    const gbenga = await e2e.signUp('gbenga');
    await e2e.fund(gbenga, 500_000n);
    expect(
      data<{ billers: unknown[] }>(await e2e.api('get', '/payments/billers', gbenga)).billers
        .length,
    ).toBe(3);
    const bill = await pay('/payments/bills', gbenga, {
      billerCode: 'DSTV',
      customerReference: '1234567890',
      amount: '150000',
      currency: 'NGN',
    });
    const billId = data<{ payment: { id: string } }>(bill).payment.id;
    await e2e.settle(billId);
    expect(await balanceOf(gbenga)).toBe(350_000n);

    const providerReference =
      (await e2e.db.payment.findUniqueOrThrow({ where: { transactionId: billId } }))
        .providerReference ?? '';
    const refund = e2e.provider.refund(providerReference, { amount: 50_000n });
    await e2e.deliver(refund);
    await e2e.deliver(refund); // the same refund delivered twice
    expect(await balanceOf(gbenga)).toBe(400_000n);
  });

  it('a payout the bank rejects later releases the hold: the money is back', async () => {
    const hana = await e2e.signUp('hana');
    await e2e.fund(hana, 500_000n);
    const out = await pay('/payments/withdrawals', hana, {
      bankCode: '058',
      accountNumber: MOCK_ACCOUNT_NUMBERS.FAILS_LATER,
      amount: '200000',
      currency: 'NGN',
    });
    const id = data<{ withdrawal: { id: string } }>(out).withdrawal.id;
    expect(
      (await e2e.db.wallet.findUniqueOrThrow({ where: { id: hana.walletId } })).availableBalance,
    ).toBe(299_000n);
    await e2e.settle(id);
    const wallet = await e2e.db.wallet.findUniqueOrThrow({ where: { id: hana.walletId } });
    expect(wallet.availableBalance).toBe(500_000n);
    expect(
      data<{ transaction: { status: string } }>(await e2e.api('get', `/transactions/${id}`, hana))
        .transaction.status,
    ).toBe('FAILED');
  });

  it('saves, renames and deletes beneficiaries; nobody else can see them', async () => {
    const ifeoma = await e2e.signUp('ifeoma');
    const jide = await e2e.signUp('jide');
    const saved = await e2e
      .api('post', '/beneficiaries', ifeoma)
      .send({ type: 'FUNDRA_WALLET', recipientHandle: jide.handle, nickname: 'Jide' });
    const id = data<{ beneficiary: { id: string } }>(saved).beneficiary.id;
    await e2e
      .api('post', '/beneficiaries', ifeoma)
      .send({ type: 'BANK_ACCOUNT', bankCode: '058', accountNumber: '0123456789' });
    expect(
      data<{ beneficiaries: unknown[] }>(await e2e.api('get', '/beneficiaries', ifeoma))
        .beneficiaries,
    ).toHaveLength(2);
    expect((await e2e.api('get', `/beneficiaries/${id}`, jide)).status).toBe(404);
    expect(
      data<{ beneficiary: { nickname: string } }>(
        await e2e.api('patch', `/beneficiaries/${id}`, ifeoma).send({ nickname: 'J' }),
      ).beneficiary.nickname,
    ).toBe('J');
    expect((await e2e.api('delete', `/beneficiaries/${id}`, ifeoma)).status).toBe(204);
  });

  it('refuses an unsigned or tampered webhook and ignores a duplicate', async () => {
    const kemi = await e2e.signUp('kemi');
    const dep = await pay('/payments/deposits', kemi, { amount: '100000', currency: 'NGN' });
    const depositId = data<{ deposit: { id: string } }>(dep).deposit.id;
    const providerReference =
      (await e2e.db.payment.findUniqueOrThrow({ where: { transactionId: depositId } }))
        .providerReference ?? '';
    const webhook = e2e.provider.settle(providerReference);
    const tampered = await request(e2e.app)
      .post('/api/v1/webhooks/payments')
      .set('X-Mock-Signature', String(webhook.headers['x-mock-signature']))
      .send(webhook.rawBody.toString().replace('100000', '900000'));
    expect(code(tampered)).toBe('INVALID_WEBHOOK_SIGNATURE');
    expect((await e2e.deliver(webhook)).status).toBe(200);
    const again = await e2e.deliver(webhook);
    expect(data<{ status: string }>(again).status).toBe('DUPLICATE');
    expect(await balanceOf(kemi)).toBe(100_000n);
  });
});
