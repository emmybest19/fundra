// Zod schemas for statements.
import { z } from 'zod';
import { lagosDate } from '../../common/utils/business-day.ts';
import { uuid } from '../../common/validators/index.ts';

/** Up to a year and a day, so any calendar year fits. */
export const MAX_STATEMENT_DAYS = 366;

const date = z.iso.date('Must be a date like 2026-10-01');

/** Lagos calendar dates, inclusive; nothing in the future. */
export const requestStatementBody = z
  .strictObject({ walletId: uuid, from: date, to: date })
  .refine((v) => v.from <= v.to, { message: 'Must not be after to', path: ['from'] })
  .refine((v) => v.to <= lagosDate(Date.now()), {
    message: 'Must not be in the future',
    path: ['to'],
  })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 + 1 <= MAX_STATEMENT_DAYS, {
    message: `A statement covers at most ${String(MAX_STATEMENT_DAYS)} days`,
    path: ['from'],
  });

export const statementParams = z.strictObject({ id: uuid });

export const listStatementsQuery = z.strictObject({ walletId: uuid.optional() });
