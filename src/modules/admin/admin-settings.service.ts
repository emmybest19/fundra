// Admin settings: tier limits (D3) and fee rules (D6). Money movement reads both on every
// transaction, so a change applies to the very next one. Every change is audited with the
// old and new values. Fee rules keep their history: a change retires the active rule and
// creates a new one, so past fees can always be explained.
import type { Currency } from '../../common/constants/currency.ts';
import { CURRENCIES } from '../../common/constants/currency.ts';
import { NotFoundError } from '../../common/errors/index.ts';
import type {
  FeeRule,
  PrismaClient,
  TierLimit,
  TransactionType,
} from '../../generated/prisma/client.ts';
import { recordAudit } from '../audit/audit.service.ts';
import type { AuditContext } from '../audit/audit.types.ts';

/** Types that charge a fee (money movement looks a rule up for each). */
export const FEE_TYPES = [
  'TRANSFER',
  'WITHDRAWAL',
  'PAYMENT',
] as const satisfies readonly TransactionType[];

const limitView = (row: TierLimit) => ({
  tier: row.tier,
  currency: row.currency,
  perTransactionLimit: row.perTransactionLimit.toString(),
  dailyOutflowLimit: row.dailyOutflowLimit.toString(),
  maxBalance: row.maxBalance?.toString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

const feeView = (row: FeeRule) => ({
  id: row.id,
  transactionType: row.transactionType,
  currency: row.currency,
  flatFee: row.flatFee.toString(),
  percentageBps: row.percentageBps,
  minFee: row.minFee?.toString() ?? null,
  maxFee: row.maxFee?.toString() ?? null,
  effectiveFrom: row.effectiveFrom.toISOString(),
});

export interface TierLimitInput {
  perTransactionLimit: bigint;
  dailyOutflowLimit: bigint;
  maxBalance: bigint | null;
}

export interface FeeRuleInput {
  flatFee: bigint;
  percentageBps: number;
  minFee: bigint | null;
  maxFee: bigint | null;
}

export class AdminSettingsService {
  readonly #db: PrismaClient;

  constructor(db: PrismaClient) {
    this.#db = db;
  }

  async get() {
    const limits = await this.#db.tierLimit.findMany({
      orderBy: [{ currency: 'asc' }, { tier: 'asc' }],
    });
    const fees = await this.#db.feeRule.findMany({
      where: { isActive: true },
      orderBy: [{ currency: 'asc' }, { transactionType: 'asc' }],
    });
    return {
      currencies: [...CURRENCIES],
      tierLimits: limits.map(limitView),
      feeRules: fees.map(feeView),
    };
  }

  /** Replaces one tier's limits. The row must exist (the seed creates every tier). */
  async updateTierLimit(
    tier: number,
    currency: Currency,
    input: TierLimitInput,
    adminId: string,
    context: AuditContext,
  ) {
    const row = await this.#db.$transaction(async (tx) => {
      const before = await tx.tierLimit.findUnique({
        where: { tier_currency: { tier, currency } },
      });
      if (before === null) throw new NotFoundError('No limits exist for that tier and currency.');
      const after = await tx.tierLimit.update({
        where: { tier_currency: { tier, currency } },
        data: {
          perTransactionLimit: input.perTransactionLimit,
          dailyOutflowLimit: input.dailyOutflowLimit,
          maxBalance: input.maxBalance,
        },
      });
      await recordAudit(tx, {
        action: 'tier_limits.updated',
        actor: { type: 'ADMIN', userId: adminId },
        resource: { type: 'tier_limit', id: `${String(tier)}:${currency}` },
        context,
        metadata: { before: limitView(before), after: limitView(after) },
      });
      return after;
    });
    return limitView(row);
  }

  /**
   * Retires the active rule for this type and currency and creates the new one, in one
   * transaction (the partial unique index allows one active rule). Takes effect at once.
   */
  async updateFeeRule(
    transactionType: (typeof FEE_TYPES)[number],
    currency: Currency,
    input: FeeRuleInput,
    adminId: string,
    context: AuditContext,
  ) {
    const row = await this.#db.$transaction(async (tx) => {
      // Locks the active rule, so two changes at once can't both retire it.
      const [current] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM fee_rules
        WHERE transaction_type = ${transactionType}::transaction_type AND currency = ${currency}
          AND is_active FOR UPDATE`;
      const before =
        current === undefined
          ? null
          : await tx.feeRule.findUniqueOrThrow({ where: { id: current.id } });
      if (before !== null) {
        await tx.feeRule.update({ where: { id: before.id }, data: { isActive: false } });
      }
      const after = await tx.feeRule.create({
        data: { transactionType, currency, ...input, isActive: true },
      });
      await recordAudit(tx, {
        action: 'fee_rules.updated',
        actor: { type: 'ADMIN', userId: adminId },
        resource: { type: 'fee_rule', id: after.id },
        context,
        metadata: { before: before === null ? null : feeView(before), after: feeView(after) },
      });
      return after;
    });
    return feeView(row);
  }
}
