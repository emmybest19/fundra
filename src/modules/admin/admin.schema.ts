// Zod schemas for admin endpoints.
import { z } from 'zod';
import { decodeCursor } from '../../common/utils/cursor.ts';
import { ROLES } from '../../common/constants/rbac.ts';
import { amount, currency, uuid } from '../../common/validators/index.ts';
import { FEE_TYPES } from './admin-settings.service.ts';

const cursor = z
  .string()
  .max(512)
  .transform((value, ctx) => {
    const position = decodeCursor(value);
    if (position === null) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid cursor; use meta.nextCursor as given' });
      return z.NEVER;
    }
    return position;
  });

const listing = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursor.optional(),
};

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** 0 allowed (a free fee), unlike `amount`. */
const kobo = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})$/, 'Must be a whole number of kobo as a string')
  .transform((value) => BigInt(value));

export const idParams = z.strictObject({ id: uuid });

export const reasonBody = z.strictObject({
  reason: z.string().trim().min(1, 'Give a reason').max(500, 'Must be at most 500 characters'),
});

export const usersQuery = z.strictObject({
  ...listing,
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
});

export const kycQueueQuery = z.strictObject({
  status: z.enum(['PENDING', 'IN_REVIEW']).optional(),
});

export const transactionsQuery = z.strictObject({
  ...listing,
  userId: uuid.optional(),
  walletId: uuid.optional(),
  reference: z.string().trim().max(40).optional(),
  type: z
    .enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'PAYMENT', 'REFUND', 'FEE', 'REVERSAL'])
    .optional(),
  status: z
    .enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'])
    .optional(),
  from: instant.optional(),
  to: instant.optional(),
});

export const webhooksQuery = z.strictObject({
  ...listing,
  status: z.enum(['RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED']).optional(),
});

export const auditQuery = z.strictObject({
  ...listing,
  actorUserId: uuid.optional(),
  action: z.string().trim().max(100).optional(),
  resourceType: z.string().trim().max(50).optional(),
  resourceId: z.string().trim().max(100).optional(),
  from: instant.optional(),
  to: instant.optional(),
});

export const tierLimitParams = z.strictObject({
  tier: z.coerce.number().int().min(1).max(3),
  currency,
});

/** The per-transaction limit can't exceed the daily one (also a database CHECK). */
export const tierLimitBody = z
  .strictObject({
    perTransactionLimit: amount,
    dailyOutflowLimit: amount,
    maxBalance: amount.nullable(),
  })
  .refine((v) => v.perTransactionLimit <= v.dailyOutflowLimit, {
    message: 'Must not be more than dailyOutflowLimit',
    path: ['perTransactionLimit'],
  });

export const feeRuleParams = z.strictObject({
  transactionType: z.enum(FEE_TYPES),
  currency,
});

export const feeRuleBody = z
  .strictObject({
    flatFee: kobo,
    percentageBps: z.number().int().min(0).max(10_000),
    minFee: kobo.nullable().default(null),
    maxFee: kobo.nullable().default(null),
  })
  .refine((v) => v.minFee === null || v.maxFee === null || v.minFee <= v.maxFee, {
    message: 'Must not be more than maxFee',
    path: ['minFee'],
  });

/** Staff roles only; USER is every account's base role. */
const staffRole = z.enum(ROLES).refine((role) => role !== 'USER', 'USER is not assignable');

export const roleBody = z.strictObject({ role: staffRole });

export const roleParams = z.strictObject({ id: uuid, role: staffRole });
