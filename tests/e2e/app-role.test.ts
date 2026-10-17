// The app running as fundra_app (prisma/sql/app-role.sql), production's database role: every
// money flow still works, and nothing the role can do switches the ledger's protections off.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../../src/modules/ledger/reconciliation.service.ts';
import { startE2e, type E2e } from '../helpers/e2e-app.ts';

let e2e: E2e;

beforeAll(async () => {
  e2e = await startE2e({ asAppRole: true });
}, 120_000);

afterAll(async () => {
  await e2e.close();
});

/** The SQLSTATE PostgreSQL returned, through Prisma's error. */
async function refusal(sql: string): Promise<string> {
  try {
    await e2e.db.$executeRawUnsafe(sql);
    return 'allowed';
  } catch (err) {
    const text = JSON.stringify(err, Object.getOwnPropertyNames(err));
    return /42501|permission denied|must be owner/.test(text)
      ? 'denied'
      : `other: ${text.slice(0, 200)}`;
  }
}

describe('as fundra_app', () => {
  it('runs as fundra_app, not the owner', async () => {
    const [row] = await e2e.db.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
    expect(row?.current_user).toBe('fundra_app');
  });

  it('every money flow works: deposit, transfer, withdrawal, statement, reconciliation', async () => {
    const ada = await e2e.signUp('ada');
    const bola = await e2e.signUp('bola');
    await e2e.fund(ada, 1_000_000n);
    const sent = await e2e
      .api('post', '/transfers', ada)
      .set('Idempotency-Key', randomUUID())
      .send({ recipientHandle: bola.handle, amount: '200000', currency: 'NGN' });
    expect(sent.status).toBe(201);
    const out = await e2e
      .api('post', '/payments/withdrawals', ada)
      .set('Idempotency-Key', randomUUID())
      .send({ bankCode: '058', accountNumber: '0123456789', amount: '100000', currency: 'NGN' });
    await e2e.settle((out.body as { data: { withdrawal: { id: string } } }).data.withdrawal.id);
    expect(
      (await e2e.db.wallet.findUniqueOrThrow({ where: { id: ada.walletId } })).ledgerBalance,
    ).toBe(699_000n);
    expect((await new ReconciliationService(e2e.db).run()).ok).toBe(true);
  });

  it.each([
    ['TRUNCATE the ledger', 'TRUNCATE ledger_entries'],
    ['disable the append-only triggers', 'ALTER TABLE ledger_entries DISABLE TRIGGER ALL'],
    ['delete ledger entries', 'DELETE FROM ledger_entries'],
    ['edit ledger entries', 'UPDATE ledger_entries SET amount = amount + 1'],
    ['edit the audit trail', 'UPDATE audit_logs SET action = action'],
    ['drop a table', 'DROP TABLE wallets'],
    ['add a column', 'ALTER TABLE wallets ADD COLUMN backdoor text'],
  ])('cannot %s (permission denied)', async (_what, sql) => {
    expect(await refusal(sql)).toBe('denied');
  });
});
