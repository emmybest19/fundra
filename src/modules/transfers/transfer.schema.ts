// Zod request schemas for transfers (D1 amounts, D2 recipients).
import { z } from 'zod';
import { amount, currency } from '../../common/validators/index.ts';
import { handle } from '../users/user.schema.ts';
import { isValidAccountNumber } from '../wallets/account-number.ts';

/** 10 digits whose check digit matches: a typo is refused before any lookup. */
export const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{10}$/, 'Must be a 10-digit account number')
  .refine(isValidAccountNumber, 'This account number is not valid. Check it for a typo');

/** D2: exactly one of handle or account number. */
const recipient = {
  recipientHandle: handle.optional(),
  recipientAccountNumber: accountNumber.optional(),
};
const exactlyOneRecipient = (value: {
  recipientHandle?: string | undefined;
  recipientAccountNumber?: string | undefined;
}) => (value.recipientHandle === undefined) !== (value.recipientAccountNumber === undefined);
const RECIPIENT_MESSAGE = 'Give exactly one of recipientHandle or recipientAccountNumber';

export const createTransferBody = z
  .strictObject({
    ...recipient,
    amount,
    currency,
    description: z.string().trim().max(140, 'Must be at most 140 characters').optional(),
  })
  .refine(exactlyOneRecipient, { message: RECIPIENT_MESSAGE, path: ['recipientHandle'] });

export type CreateTransferInput = z.output<typeof createTransferBody>;

/** GET /transfers/recipient?handle=… or ?accountNumber=… (&currency=NGN). */
export const recipientQuery = z
  .strictObject({
    handle: handle.optional(),
    accountNumber: accountNumber.optional(),
    currency: currency.default('NGN'),
  })
  .refine((q) => (q.handle === undefined) !== (q.accountNumber === undefined), {
    message: 'Give exactly one of handle or accountNumber',
    path: ['handle'],
  });

export type RecipientQuery = z.output<typeof recipientQuery>;
