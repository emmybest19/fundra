// Tier → limits (D3). The lookup and the rules live here; money movement applies them inside
// its own transaction, under the wallet lock, with figures it read there (Stages 13–14).
import { CURRENCIES, formatMinor, type Currency } from '../../common/constants/currency.ts';
import { ErrorCode, UnprocessableError } from '../../common/errors/index.ts';
import type {
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from '../../generated/prisma/client.ts';

export interface TierLimits {
  perTransaction: bigint;
  dailyOutflow: bigint;
  /** null = unlimited. Only ever an explicit NULL in the table, never a missing row. */
  maxBalance: bigint | null;
}

/** Money leaving a wallet at the user's request: these count toward the outflow limits. */
export const OUTFLOW_TYPES: readonly TransactionType[] = ['TRANSFER', 'WITHDRAWAL', 'PAYMENT'];

/**
 * Outflows that count toward today's total: anything that has left, or is on its way out.
 * FAILED, CANCELLED and REVERSED ones gave the money back, so they don't use up the limit.
 */
export const OUTFLOW_COUNTED_STATUSES: readonly TransactionStatus[] = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
];

type LimitsReader = Pick<PrismaClient, 'tierLimit'>;

/**
 * The limits for a tier and currency. Tier 0 has none: it can't move money at all, so the
 * caller refuses before asking. A missing row for a verified tier is a configuration error
 * and fails closed: it never means "unlimited". Read on every transaction (one primary-key
 * lookup, no cache), so an admin's change applies to the very next one.
 */
export async function findTierLimits(
  db: LimitsReader,
  tier: number,
  currency: Currency,
): Promise<TierLimits | null> {
  if (tier === 0) return null;
  const row = await db.tierLimit.findUnique({ where: { tier_currency: { tier, currency } } });
  if (row === null)
    throw new Error(`No tier limits configured for tier ${String(tier)} ${currency}`);
  return {
    perTransaction: row.perTransactionLimit,
    dailyOutflow: row.dailyOutflowLimit,
    maxBalance: row.maxBalance,
  };
}

export type OutflowViolation =
  | { rule: 'PER_TRANSACTION'; limit: bigint }
  | { rule: 'DAILY_OUTFLOW'; limit: bigint; remaining: bigint };

/**
 * Whether `amount + fee` (everything leaving the wallet) may go out, given what has already
 * gone out today (`outflowToday`: OUTFLOW_TYPES in OUTFLOW_COUNTED_STATUSES since Lagos
 * midnight, amount + fee each). Exactly at a limit is allowed.
 */
export function checkOutflow(input: {
  limits: TierLimits;
  amount: bigint;
  fee: bigint;
  outflowToday: bigint;
}): OutflowViolation | null {
  const { limits, amount, fee, outflowToday } = input;
  const total = amount + fee;
  if (total > limits.perTransaction) {
    return { rule: 'PER_TRANSACTION', limit: limits.perTransaction };
  }
  if (outflowToday + total > limits.dailyOutflow) {
    const remaining = limits.dailyOutflow - outflowToday;
    return {
      rule: 'DAILY_OUTFLOW',
      limit: limits.dailyOutflow,
      remaining: remaining > 0n ? remaining : 0n,
    };
  }
  return null;
}

/**
 * Why money arrives. Refunds and reversals return the user's own money and are never
 * blocked: a reversal that fails on a limit would strand funds in limbo.
 */
export type InflowKind = 'DEPOSIT' | 'TRANSFER_IN' | 'REFUND' | 'REVERSAL';

export interface InflowViolation {
  rule: 'MAX_BALANCE';
  limit: bigint;
}

/** Whether the balance may reach `balanceAfter` (ledger balance after the credit). */
export function checkInflow(input: {
  limits: TierLimits;
  kind: InflowKind;
  balanceAfter: bigint;
}): InflowViolation | null {
  const { limits, kind, balanceAfter } = input;
  if (kind === 'REFUND' || kind === 'REVERSAL' || limits.maxBalance === null) return null;
  return balanceAfter > limits.maxBalance
    ? { rule: 'MAX_BALANCE', limit: limits.maxBalance }
    : null;
}

/**
 * The sender's own limits: their data, so the message says the limit and what's left today.
 * Clients can read the exact figures from GET /kyc (limits).
 */
export function outflowLimitError(
  violation: OutflowViolation,
  currency: Currency,
): UnprocessableError {
  if (violation.rule === 'PER_TRANSACTION') {
    return new UnprocessableError(
      `This is above your limit of ${formatMinor(violation.limit, currency)} per transaction (fees included). Upgrade your verification tier to send more.`,
      { code: ErrorCode.LIMIT_PER_TRANSACTION_EXCEEDED },
    );
  }
  return new UnprocessableError(
    `This would take you over your daily limit of ${formatMinor(violation.limit, currency)} (fees included). You can send up to ${formatMinor(violation.remaining, currency)} more today; the limit resets at midnight, Lagos time.`,
    { code: ErrorCode.LIMIT_DAILY_OUTFLOW_EXCEEDED },
  );
}

/**
 * A credit refused by the max balance. Into your own wallet (a deposit) you're told the limit.
 * Into someone else's, you learn nothing about them: not their tier, limit or balance.
 */
export function inflowLimitError(
  violation: InflowViolation,
  currency: Currency,
  recipient: 'SELF' | 'OTHER',
): UnprocessableError {
  return recipient === 'SELF'
    ? new UnprocessableError(
        `This would take your balance over your limit of ${formatMinor(violation.limit, currency)}. Upgrade your verification tier to hold more.`,
        { code: ErrorCode.LIMIT_MAX_BALANCE_EXCEEDED },
      )
    : new UnprocessableError("The recipient can't receive this amount right now.", {
        code: ErrorCode.RECIPIENT_CANNOT_RECEIVE,
      });
}

/** Amounts as kobo strings (D1): JSON numbers can't hold every bigint exactly. */
export interface TierLimitsView {
  perTransaction: string;
  dailyOutflow: string;
  maxBalance: string | null;
}

export type LimitsByCurrency = Partial<Record<Currency, TierLimitsView>>;

/** Limits for a tier in every currency Fundra runs, for display; null at tier 0 or past 3. */
export async function tierLimitsView(
  db: LimitsReader,
  tier: number,
): Promise<LimitsByCurrency | null> {
  if (tier < 1 || tier > 3) return null;
  const view: LimitsByCurrency = {};
  for (const currency of CURRENCIES) {
    const limits = await findTierLimits(db, tier, currency);
    if (limits === null) return null;
    view[currency] = {
      perTransaction: limits.perTransaction.toString(),
      dailyOutflow: limits.dailyOutflow.toString(),
      maxBalance: limits.maxBalance?.toString() ?? null,
    };
  }
  return view;
}
