// Fees (D6): the calculation and the lookup of the rule in force. Money movement adds the fee
// as extra entries in its own ledger transaction.
import type { Currency } from '../../common/constants/currency.ts';
import type { PrismaClient, TransactionType } from '../../generated/prisma/client.ts';

export interface FeeRuleValues {
  flatFee: bigint;
  /** Basis points: 1 bp = 0.01%. */
  percentageBps: number;
  minFee: bigint | null;
  maxFee: bigint | null;
}

/**
 * D6: flat + amount × bps / 10 000, rounded **down** (any fraction of a kobo is the
 * customer's), then clamped to [minFee, maxFee]. Integer maths only.
 */
export function computeFee(amount: bigint, rule: FeeRuleValues): bigint {
  let fee = rule.flatFee + (amount * BigInt(rule.percentageBps)) / 10_000n;
  if (rule.minFee !== null && fee < rule.minFee) fee = rule.minFee;
  if (rule.maxFee !== null && fee > rule.maxFee) fee = rule.maxFee;
  return fee;
}

/**
 * The fee for `amount` under the active rule for this type and currency. A missing rule is a
 * configuration error and fails closed: it never means "free".
 */
export async function feeFor(
  db: Pick<PrismaClient, 'feeRule'>,
  type: TransactionType,
  amount: bigint,
  currency: Currency,
  now: number,
): Promise<bigint> {
  const rule = await db.feeRule.findFirst({
    where: {
      transactionType: type,
      currency,
      isActive: true,
      effectiveFrom: { lte: new Date(now) },
    },
  });
  if (rule === null) throw new Error(`No active ${type} fee rule for ${currency}`);
  return computeFee(amount, rule);
}
