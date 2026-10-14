// Zod request schemas for transactions.
import { z } from 'zod';
import { decodeCursor } from '../../common/utils/cursor.ts';
import { uuid } from '../../common/validators/index.ts';

const TYPES = [
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'PAYMENT',
  'REFUND',
  'FEE',
  'REVERSAL',
] as const;
const STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED'] as const;

const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/**
 * GET /transactions. Newest first. `from` is inclusive, `to` exclusive. `direction` is relative
 * to the caller: `in` = money arriving in their wallet, `out` = money leaving it.
 */
export const historyQuery = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .max(512)
      .transform((value, ctx) => {
        const position = decodeCursor(value);
        if (position === null) {
          ctx.addIssue({
            code: 'custom',
            message: 'Not a valid cursor; use meta.nextCursor as given',
          });
          return z.NEVER;
        }
        return position;
      })
      .optional(),
    walletId: uuid.optional(),
    type: z.enum(TYPES).optional(),
    status: z.enum(STATUSES).optional(),
    direction: z.enum(['in', 'out']).optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, {
    message: '`from` must be before `to`',
    path: ['from'],
  });

export type HistoryQuery = z.output<typeof historyQuery>;

export const transactionParams = z.strictObject({ id: uuid });
