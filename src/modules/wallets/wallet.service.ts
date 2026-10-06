// Business logic for wallets. Creation runs inside the caller's transaction: KYC approval
// (Stage 9) and the wallet commit together, so an approved user always has a wallet.
import type { Currency } from '../../common/constants/currency.ts';
import type { Prisma, Wallet } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditActor, AuditContext } from '../audit/audit.types.ts';
import { walletAccountCode } from '../ledger/ledger.utils.ts';
import { generateAccountNumber } from './account-number.ts';

/** Fresh numbers to try before giving up: with 10⁹ possibilities, 5 clashes means a bug. */
const ACCOUNT_NUMBER_ATTEMPTS = 5;

/**
 * Creates the user's wallet in `currency`, with its own ledger account, unless one exists
 * (then it's returned unchanged). Balances start at 0: only the ledger ever changes them.
 *
 * The wallet ID comes from PostgreSQL first (`uuidv7()`), because the ledger account's code
 * contains it (`WALLET:<id>`). The unique (user_id, currency) index makes a second wallet
 * impossible even if two callers race; the unique account-number index is the backstop for
 * the (astronomically unlikely) case that two approvals pick the same free number at once.
 */
export async function createWallet(
  tx: Prisma.TransactionClient,
  input: { userId: string; currency: Currency; actor: AuditActor; context: AuditContext },
): Promise<Wallet> {
  const existing = await tx.wallet.findUnique({
    where: { userId_currency: { userId: input.userId, currency: input.currency } },
  });
  if (existing !== null) return existing;

  const accountNumber = await freeAccountNumber(tx);
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`;
  if (row === undefined) throw new Error('uuidv7() returned no row');

  const ledgerAccount = await tx.ledgerAccount.create({
    data: { code: walletAccountCode(row.id), type: 'LIABILITY', currency: input.currency },
  });
  const wallet = await tx.wallet.create({
    data: {
      id: row.id,
      userId: input.userId,
      currency: input.currency,
      accountNumber,
      ledgerAccountId: ledgerAccount.id,
    },
  });
  await recordAudit(tx, {
    action: 'wallet.created',
    actor: input.actor,
    resource: { type: 'wallet', id: wallet.id },
    context: input.context,
    // The wallet ID only: account numbers stay out of logs and audit records.
    metadata: { userId: input.userId, currency: input.currency, ledgerAccountId: ledgerAccount.id },
  });
  return wallet;
}

async function freeAccountNumber(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < ACCOUNT_NUMBER_ATTEMPTS; attempt++) {
    const candidate = generateAccountNumber();
    const taken = await tx.wallet.findUnique({
      where: { accountNumber: candidate },
      select: { id: true },
    });
    if (taken === null) return candidate;
  }
  throw new Error(`No free account number after ${String(ACCOUNT_NUMBER_ATTEMPTS)} attempts`);
}
