// Zod request schemas for payments (D1 amounts).
import { z } from 'zod';
import { amount, currency } from '../../common/validators/index.ts';

/** The amount to add, in kobo. The provider's fee, if any, is the customer's at checkout. */
export const createDepositBody = z.strictObject({ amount, currency });

export type CreateDepositInput = z.output<typeof createDepositBody>;
