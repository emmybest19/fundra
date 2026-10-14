// Types for transfers: the fee calculation (D6) and the recipient as a sender sees it.

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

/** All a sender learns about a recipient: enough to confirm who they're paying. */
export interface RecipientView {
  name: string;
  handle: string;
}
