// Zod request schemas for wallets.
import { z } from 'zod';
import { uuid } from '../../common/validators/index.ts';

export const walletParams = z.strictObject({ id: uuid });
