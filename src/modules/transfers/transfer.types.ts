// Types for transfers: the recipient as a sender sees it (D2). Fees live in transactions/fees.ts.

/** All a sender learns about a recipient: enough to confirm who they're paying. */
export interface RecipientView {
  name: string;
  handle: string;
}
