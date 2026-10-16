// Beneficiaries: recipients a user saves to pay again (docs/ARCHITECTURE.md §6.4). Every read
// and write is scoped to the owner: someone else's beneficiary is a plain 404. The recipient's
// name always comes from Fundra (a wallet) or the bank (name enquiry), never from the client.
import {
  ConflictError,
  ErrorCode,
  isUniqueViolation,
  NotFoundError,
  UnprocessableError,
} from '../../common/errors/index.ts';
import type { Beneficiary, Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';
import { maskAccountNumber } from '../payments/outbound-payment.service.ts';
import type { ResolvedBankAccount } from '../payments/providers/payment-provider.ts';
import { findRecipientWallet } from '../transfers/transfer.service.ts';
import type { CreateBeneficiaryInput } from './beneficiary.schema.ts';

/** Enough for anyone's real list; stops a script filling the table. */
export const MAX_BENEFICIARIES = 100;

/** Name enquiry, as OutboundPaymentService does it (404 / 503 included). */
export interface BankAccountResolver {
  resolveBankAccount(account: {
    bankCode: string;
    accountNumber: string;
  }): Promise<ResolvedBankAccount>;
}

export type BeneficiaryView =
  | {
      id: string;
      type: 'FUNDRA_WALLET';
      nickname: string | null;
      /** As the D2 lookup shows it: name and handle only. */
      recipient: { name: string; handle: string };
      /** False once the recipient can no longer receive (closed wallet, account gone). */
      available: boolean;
      lastUsedAt: string | null;
      createdAt: string;
    }
  | {
      id: string;
      type: 'BANK_ACCOUNT';
      nickname: string | null;
      /** The owner's own saved data, in full, so it can be used to withdraw. */
      bankAccount: { bankCode: string; accountNumber: string; accountName: string };
      lastUsedAt: string | null;
      createdAt: string;
    };

const WITH_RECIPIENT = {
  recipientWallet: {
    select: {
      status: true,
      user: { select: { firstName: true, lastName: true, handle: true, status: true } },
    },
  },
} as const satisfies Prisma.BeneficiaryInclude;

type Row = Prisma.BeneficiaryGetPayload<{ include: typeof WITH_RECIPIENT }>;

function viewOf(row: Row): BeneficiaryView {
  const common = {
    id: row.id,
    nickname: row.nickname,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.type === 'FUNDRA_WALLET') {
    const wallet = row.recipientWallet;
    const user = wallet?.user;
    return {
      ...common,
      type: 'FUNDRA_WALLET',
      recipient: {
        name: user === undefined ? 'Unknown' : `${user.firstName} ${user.lastName}`,
        handle: user?.handle ?? '',
      },
      available:
        wallet !== null &&
        wallet.status !== 'CLOSED' &&
        user?.status !== 'SUSPENDED' &&
        user?.status !== 'DEACTIVATED',
    };
  }
  return {
    ...common,
    type: 'BANK_ACCOUNT',
    bankAccount: {
      bankCode: row.bankCode ?? '',
      accountNumber: row.bankAccountNumber ?? '',
      accountName: row.bankAccountName ?? '',
    },
  };
}

/** What the audit log keeps: who, not the full account number. */
function auditOf(row: Beneficiary): Record<string, unknown> {
  return row.type === 'FUNDRA_WALLET'
    ? { type: row.type, recipientWalletId: row.recipientWalletId, nickname: row.nickname }
    : {
        type: row.type,
        bankCode: row.bankCode,
        accountNumber: maskAccountNumber(row.bankAccountNumber ?? ''),
        nickname: row.nickname,
      };
}

const notFound = () => new NotFoundError('Beneficiary not found.');

export class BeneficiaryService {
  readonly #db: PrismaClient;
  readonly #banks: BankAccountResolver;

  constructor(db: PrismaClient, banks: BankAccountResolver) {
    this.#db = db;
    this.#banks = banks;
  }

  /** Most recently used first, then newest. */
  async list(userId: string, type?: Beneficiary['type']): Promise<BeneficiaryView[]> {
    const rows = await this.#db.beneficiary.findMany({
      where: { userId, ...(type === undefined ? {} : { type }) },
      include: WITH_RECIPIENT,
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return rows.map(viewOf);
  }

  async get(userId: string, id: string): Promise<BeneficiaryView> {
    const row = await this.#db.beneficiary.findFirst({
      where: { id, userId },
      include: WITH_RECIPIENT,
    });
    if (row === null) throw notFound();
    return viewOf(row);
  }

  async create(
    userId: string,
    input: CreateBeneficiaryInput,
    context: AuditContext,
  ): Promise<BeneficiaryView> {
    // Looked up before the transaction: name enquiry is a provider call.
    const data: Prisma.BeneficiaryUncheckedCreateInput =
      input.type === 'FUNDRA_WALLET'
        ? await this.#fundraWallet(userId, input)
        : await this.#bankAccount(userId, input);

    try {
      const row = await this.#db.$transaction(async (tx) => {
        // The owner's row lock makes count-then-insert safe against parallel adds.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        if ((await tx.beneficiary.count({ where: { userId } })) >= MAX_BENEFICIARIES) {
          throw new UnprocessableError(
            `You can save up to ${String(MAX_BENEFICIARIES)} beneficiaries. Delete one to add another.`,
            { code: ErrorCode.BENEFICIARY_LIMIT },
          );
        }
        const created = await tx.beneficiary.create({ data, include: WITH_RECIPIENT });
        await recordAudit(tx, {
          action: 'beneficiary.created',
          actor: { type: 'USER', userId },
          resource: { type: 'beneficiary', id: created.id },
          context,
          metadata: auditOf(created),
        });
        return created;
      });
      return viewOf(row);
    } catch (err) {
      if (
        isUniqueViolation(err, 'beneficiaries_wallet_unique_idx', 'beneficiaries_bank_unique_idx')
      ) {
        throw new ConflictError('This beneficiary is already saved.', {
          code: ErrorCode.BENEFICIARY_EXISTS,
        });
      }
      throw err;
    }
  }

  /** Renames only; the recipient itself never changes. */
  async update(
    userId: string,
    id: string,
    nickname: string | null,
    context: AuditContext,
  ): Promise<BeneficiaryView> {
    const row = await this.#db.$transaction(async (tx) => {
      const { count } = await tx.beneficiary.updateMany({
        where: { id, userId },
        data: { nickname },
      });
      if (count === 0) throw notFound();
      const updated = await tx.beneficiary.findUniqueOrThrow({
        where: { id },
        include: WITH_RECIPIENT,
      });
      await recordAudit(tx, {
        action: 'beneficiary.updated',
        actor: { type: 'USER', userId },
        resource: { type: 'beneficiary', id },
        context,
        metadata: { nickname },
      });
      return updated;
    });
    return viewOf(row);
  }

  async delete(userId: string, id: string, context: AuditContext): Promise<void> {
    await this.#db.$transaction(async (tx) => {
      const row = await tx.beneficiary.findFirst({ where: { id, userId } });
      if (row === null) throw notFound();
      // Transfers sent from it keep their history; only the link goes.
      await tx.transfer.updateMany({ where: { beneficiaryId: id }, data: { beneficiaryId: null } });
      await tx.beneficiary.delete({ where: { id } });
      await recordAudit(tx, {
        action: 'beneficiary.deleted',
        actor: { type: 'USER', userId },
        resource: { type: 'beneficiary', id },
        context,
        metadata: auditOf(row),
      });
    });
  }

  async #fundraWallet(
    userId: string,
    input: Extract<CreateBeneficiaryInput, { type: 'FUNDRA_WALLET' }>,
  ): Promise<Prisma.BeneficiaryUncheckedCreateInput> {
    const wallet = await findRecipientWallet(this.#db, input.currency, {
      ...(input.recipientHandle === undefined ? {} : { handle: input.recipientHandle }),
      ...(input.recipientAccountNumber === undefined
        ? {}
        : { accountNumber: input.recipientAccountNumber }),
    });
    if (wallet.userId === userId) {
      throw new UnprocessableError("You can't save yourself as a beneficiary.", {
        code: ErrorCode.BENEFICIARY_SELF,
      });
    }
    return {
      userId,
      type: 'FUNDRA_WALLET',
      recipientWalletId: wallet.id,
      nickname: input.nickname ?? null,
    };
  }

  async #bankAccount(
    userId: string,
    input: Extract<CreateBeneficiaryInput, { type: 'BANK_ACCOUNT' }>,
  ): Promise<Prisma.BeneficiaryUncheckedCreateInput> {
    const account = await this.#banks.resolveBankAccount({
      bankCode: input.bankCode,
      accountNumber: input.accountNumber,
    });
    return {
      userId,
      type: 'BANK_ACCOUNT',
      bankCode: account.bankCode,
      bankAccountNumber: account.accountNumber,
      bankAccountName: account.accountName,
      nickname: input.nickname ?? null,
    };
  }
}
