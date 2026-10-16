// Zod schemas for beneficiaries: saved Fundra recipients and bank accounts.
import { z } from 'zod';
import { currency, uuid } from '../../common/validators/index.ts';
import { bankAccount } from '../payments/payment.schema.ts';
import { accountNumber } from '../transfers/transfer.schema.ts';
import { handle } from '../users/user.schema.ts';

const nickname = z
  .string()
  .trim()
  .min(1, 'Must not be empty')
  .max(50, 'Must be at most 50 characters');

const fundraWallet = z
  .strictObject({
    type: z.literal('FUNDRA_WALLET'),
    recipientHandle: handle.optional(),
    recipientAccountNumber: accountNumber.optional(),
    currency: currency.default('NGN'),
    nickname: nickname.optional(),
  })
  .refine((v) => (v.recipientHandle === undefined) !== (v.recipientAccountNumber === undefined), {
    message: 'Give exactly one of recipientHandle or recipientAccountNumber',
    path: ['recipientHandle'],
  });

const bank = z.strictObject({
  type: z.literal('BANK_ACCOUNT'),
  ...bankAccount,
  nickname: nickname.optional(),
});

/** What to save. The name always comes from Fundra or the bank, never from the request. */
export const createBeneficiaryBody = z.discriminatedUnion('type', [fundraWallet, bank]);

export type CreateBeneficiaryInput = z.output<typeof createBeneficiaryBody>;

/**
 * Only the nickname changes (`null` clears it). Who the beneficiary is never does: a saved
 * recipient silently pointing somewhere new is how money gets misdirected. Delete and re-add.
 */
export const updateBeneficiaryBody = z.strictObject({ nickname: nickname.nullable() });

export const beneficiaryParams = z.strictObject({ id: uuid });

export const listBeneficiariesQuery = z.strictObject({
  type: z.enum(['FUNDRA_WALLET', 'BANK_ACCOUNT']).optional(),
});
