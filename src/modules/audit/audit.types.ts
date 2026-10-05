// Audit action and resource types.

/**
 * Every audited action, as `domain.event`. A typo is a compile error, and this list is the
 * catalogue of what the audit trail can contain. Modules add their actions as they're built.
 */
export const AUDIT_ACTIONS = [
  // Authentication & sessions (Stage 7)
  'user.registered',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.account_locked',
  'auth.logout',
  'auth.password_changed',
  'auth.password_reset_requested',
  'auth.password_reset',
  'user.email_verified',
  'user.phone_verified',
  'auth.token_reuse_detected',
  'auth.session_revoked',
  'auth.reauth_failed',
  // Users & access (Stages 8, 19)
  'user.profile_updated',
  'user.preferences_updated',
  'user.contact_change_requested',
  'user.email_changed',
  'user.phone_changed',
  'user.suspended',
  'user.reactivated',
  'user.deactivated',
  'role.granted',
  'role.revoked',
  // KYC (Stage 9)
  'kyc.document_uploaded',
  'kyc.submitted',
  'kyc.review_started',
  'kyc.approved',
  'kyc.rejected',
  // Wallets (Stage 10)
  'wallet.created',
  'wallet.frozen',
  'wallet.unfrozen',
  // Money movement (Stages 13–14)
  'transfer.completed',
  'deposit.completed',
  'withdrawal.requested',
  'withdrawal.completed',
  'payment.completed',
  'transaction.reversed',
  // Beneficiaries (Stage 18)
  'beneficiary.created',
  'beneficiary.updated',
  'beneficiary.deleted',
  // Administration (Stage 19)
  'settings.updated',
  'tier_limits.updated',
  'fee_rules.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Who acted. Users and admins are always identified; the system never is. */
export type AuditActor = { type: 'USER' | 'ADMIN'; userId: string } | { type: 'SYSTEM' };

/** Where the action came from. Taken from the HTTP request when there is one. */
export interface AuditContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export interface AuditEntry {
  action: AuditAction;
  actor: AuditActor;
  /** What was acted on, e.g. `{ type: 'wallet', id: walletId }`. */
  resource?: { type: string; id: string };
  context?: AuditContext;
  /** Extra facts. Sanitized before storage; never put secrets here regardless. */
  metadata?: Record<string, unknown>;
}
