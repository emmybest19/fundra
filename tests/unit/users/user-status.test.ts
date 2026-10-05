import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../src/common/errors/index.ts';
import type { UserStatus } from '../../../src/generated/prisma/client.ts';
import {
  assertStatusTransition,
  canTransition,
  statusAfterVerification,
  STATUS_TRANSITIONS,
} from '../../../src/modules/users/user-status.ts';

const ALL: UserStatus[] = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'];

describe('status transitions', () => {
  it('covers every status', () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('never allows a no-op transition', () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });

  it.each<[UserStatus, UserStatus]>([
    ['PENDING_VERIFICATION', 'ACTIVE'],
    ['ACTIVE', 'DEACTIVATED'],
    ['PENDING_VERIFICATION', 'DEACTIVATED'],
    ['ACTIVE', 'SUSPENDED'],
    ['SUSPENDED', 'ACTIVE'],
    ['DEACTIVATED', 'ACTIVE'],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => {
      assertStatusTransition(from, to);
    }).not.toThrow();
  });

  it('never sends a verified account back to PENDING_VERIFICATION', () => {
    expect(canTransition('ACTIVE', 'PENDING_VERIFICATION')).toBe(false);
  });

  it('rejects a disallowed transition with a 409', () => {
    expect(() => {
      assertStatusTransition('DEACTIVATED', 'SUSPENDED');
    }).toThrow(expect.objectContaining({ statusCode: 409 }) as AppError);
  });
});

describe('statusAfterVerification', () => {
  const at = new Date();

  it('activates a pending account once email and phone are both verified', () => {
    expect(
      statusAfterVerification({
        status: 'PENDING_VERIFICATION',
        emailVerifiedAt: at,
        phoneVerifiedAt: at,
      }),
    ).toBe('ACTIVE');
  });

  it('leaves a pending account pending while either is unverified', () => {
    expect(
      statusAfterVerification({
        status: 'PENDING_VERIFICATION',
        emailVerifiedAt: at,
        phoneVerifiedAt: null,
      }),
    ).toBe('PENDING_VERIFICATION');
  });

  it('never reactivates a suspended or deactivated account', () => {
    for (const status of ['SUSPENDED', 'DEACTIVATED'] as const) {
      expect(statusAfterVerification({ status, emailVerifiedAt: at, phoneVerifiedAt: at })).toBe(
        status,
      );
    }
  });
});
