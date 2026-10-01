import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type Permission,
} from '../../../src/common/constants/rbac.ts';

const allPermissions = Object.keys(PERMISSIONS) as Permission[];

describe('RBAC catalogue', () => {
  it('uses resource:action keys that satisfy the database CHECK', () => {
    for (const key of allPermissions) expect(key).toMatch(/^[a-z_]+:[a-z_]+$/);
  });

  it('describes every role and permission', () => {
    for (const role of ROLES) expect(ROLE_DESCRIPTIONS[role]).not.toBe('');
    for (const key of allPermissions) expect(PERMISSIONS[key]).not.toBe('');
  });

  it('gives SUPER_ADMIN every permission', () => {
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual([...allPermissions].sort());
  });

  it('gives customers no permissions (they act on what they own)', () => {
    expect(ROLE_PERMISSIONS.USER).toEqual([]);
  });

  it('lists no permission twice for a role', () => {
    for (const role of ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size).toBe(granted.length);
    }
  });

  it('keeps SUPPORT read-only', () => {
    for (const key of ROLE_PERMISSIONS.SUPPORT) expect(key).toMatch(/:read$/);
  });

  it('separates duties: no role but SUPER_ADMIN can both approve KYC and reverse money', () => {
    const both = ROLES.filter(
      (role) =>
        ROLE_PERMISSIONS[role].includes('kyc:review') &&
        ROLE_PERMISSIONS[role].includes('transactions:reverse'),
    );
    expect(both).toEqual(['SUPER_ADMIN']);
  });

  it('reserves role assignment and settings changes for SUPER_ADMIN', () => {
    const holders = (key: Permission) =>
      ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(key));

    expect(holders('roles:assign')).toEqual(['SUPER_ADMIN']);
    expect(holders('settings:update')).toEqual(['SUPER_ADMIN']);
  });
});
