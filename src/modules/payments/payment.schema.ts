// Zod request schemas for payments (D1 amounts).
import { z } from 'zod';
import { amount, currency } from '../../common/validators/index.ts';

/** The amount to add, in kobo. The provider's fee, if any, is the customer's at checkout. */
export const createDepositBody = z.strictObject({ amount, currency });

export type CreateDepositInput = z.output<typeof createDepositBody>;

/** A Nigerian bank account: CBN bank code and 10-digit NUBAN. The bank checks the rest. */
export const bankAccount = {
  bankCode: z
    .string()
    .trim()
    .regex(/^\d{3,6}$/, 'Must be a 3–6 digit bank code'),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Must be a 10-digit account number'),
};

/** GET /payments/bank-accounts/resolve?bankCode=058&accountNumber=0123456789 */
export const bankAccountQuery = z.strictObject(bankAccount);

export type BankAccountQuery = z.output<typeof bankAccountQuery>;

/** The amount reaches the bank account; the withdrawal fee is charged on top. */
export const createWithdrawalBody = z.strictObject({
  ...bankAccount,
  amount,
  currency,
  description: z.string().trim().max(100, 'Must be at most 100 characters').optional(),
});

export type CreateWithdrawalInput = z.output<typeof createWithdrawalBody>;

/** A bill payment: the biller's code (GET /payments/billers) and what's being paid for. */
export const createBillPaymentBody = z.strictObject({
  billerCode: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]{2,40}$/, 'Must be a biller code from GET /payments/billers'),
  customerReference: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,30}$/, 'Must be 4–30 letters, digits or dashes'),
  amount,
  currency,
  description: z.string().trim().max(100, 'Must be at most 100 characters').optional(),
});

export type CreateBillPaymentInput = z.output<typeof createBillPaymentBody>;
