// Zod request schemas for the in-app notification feed.
import { z } from 'zod';
import { decodeCursor } from '../../common/utils/cursor.ts';
import { uuid } from '../../common/validators/index.ts';

/** GET /notifications: newest first; `unread=true` for unread only. */
export const feedQuery = z.strictObject({
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
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type FeedQuery = z.output<typeof feedQuery>;

export const notificationParams = z.strictObject({ id: uuid });
