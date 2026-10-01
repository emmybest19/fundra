// Roles and permissions. Single source of truth: the seed writes these to the database,
// and route guards check the same keys, so code and data can't drift apart.

export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'COMPLIANCE', 'FINANCE', 'USER'] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Readonly<Record<RoleName, string>> = {
  SUPER_ADMIN: 'Full access, including role assignment and system settings',
  ADMIN: 'Platform operations: users, wallets and monitoring',
  SUPPORT: 'Read-only access for customer support',
  COMPLIANCE: 'KYC review, account suspension and wallet freezes',
  FINANCE: 'Transaction investigation and reversals',
  USER: 'Customer. Access is limited to resources they own',
};

/** Permission keys follow `resource:action` (enforced by a database CHECK). */
export const PERMISSIONS = {
  'users:read': 'View user accounts and profiles',
  'users:suspend': 'Suspend and reactivate user accounts',
  'kyc:read': 'View KYC profiles and documents',
  'kyc:review': 'Approve or reject KYC submissions',
  'wallets:read': 'View wallets and balances',
  'wallets:freeze': 'Freeze and unfreeze wallets',
  'transactions:read': 'View and investigate transactions',
  'transactions:reverse': 'Reverse completed transactions',
  'webhooks:read': 'View received provider webhooks',
  'audit_logs:read': 'View the audit trail',
  'settings:read': 'View system settings, tier limits and fees',
  'settings:update': 'Change system settings, tier limits and fees',
  'roles:assign': 'Grant and revoke roles',
} as const;
export type Permission = keyof typeof PERMISSIONS;

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Separation of duties: approving identities (COMPLIANCE) and moving money back
 * (FINANCE) belong to different roles; only SUPER_ADMIN holds everything.
 * Customers (USER) need no permissions: they act on resources they own.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ADMIN: [
    'users:read',
    'users:suspend',
    'kyc:read',
    'wallets:read',
    'wallets:freeze',
    'transactions:read',
    'webhooks:read',
    'audit_logs:read',
    'settings:read',
  ],
  SUPPORT: ['users:read', 'kyc:read', 'wallets:read', 'transactions:read'],
  COMPLIANCE: [
    'users:read',
    'users:suspend',
    'kyc:read',
    'kyc:review',
    'wallets:read',
    'wallets:freeze',
    'transactions:read',
    'audit_logs:read',
  ],
  FINANCE: [
    'wallets:read',
    'transactions:read',
    'transactions:reverse',
    'webhooks:read',
    'audit_logs:read',
    'settings:read',
  ],
  USER: [],
};
