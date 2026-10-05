// User preferences (users.preferences, jsonb): which notifications go to which channel.
// Stage 17's notification worker reads these before sending.
import { z } from 'zod';

interface ChannelDefaults {
  email: boolean;
  sms: boolean;
  push: boolean;
}

/**
 * Missing keys take their defaults, so `{}` (the column default) and rows written before a
 * preference existed both read as a complete object. `prefault` runs the default through the
 * schema; a plain `default({})` would return `{}` unfilled.
 */
const channels = (defaults: ChannelDefaults) =>
  z
    .object({
      email: z.boolean().default(defaults.email),
      sms: z.boolean().default(defaults.sms),
      push: z.boolean().default(defaults.push),
    })
    .prefault({});

/**
 * The stored shape. Unknown keys are dropped rather than rejected, so a retired preference in
 * an old row never breaks reading it.
 *
 * - transactions: money in and out. SMS is off by default (it costs per message).
 * - security: sign-ins, password and contact changes. **Email can't be turned off**: it's how
 *   a user learns their account was taken over.
 * - marketing: opt-in only (NDPR consent), so everything defaults to off.
 */
export const userPreferences = z.object({
  notifications: z
    .object({
      transactions: channels({ email: true, sms: false, push: true }),
      security: z
        .object({
          email: z
            .boolean()
            .default(true)
            .transform(() => true as const),
          sms: z.boolean().default(true),
          push: z.boolean().default(true),
        })
        .prefault({}),
      marketing: channels({ email: false, sms: false, push: false }),
    })
    .prefault({}),
});

export type UserPreferences = z.output<typeof userPreferences>;

export const DEFAULT_PREFERENCES: UserPreferences = userPreferences.parse({});

/** Reads the stored column. Anything unreadable falls back to the defaults. */
export function readPreferences(stored: unknown): UserPreferences {
  const parsed = userPreferences.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

const toggles = z.strictObject({
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  push: z.boolean().optional(),
});

/** PATCH body: any subset, strictly validated (unknown keys are a 400, not silently dropped). */
export const preferencesPatch = z
  .strictObject({
    notifications: z
      .strictObject({
        transactions: toggles.optional(),
        security: z
          .strictObject({
            email: z
              .literal(true, { error: "Security alerts by email can't be turned off" })
              .optional(),
            sms: z.boolean().optional(),
            push: z.boolean().optional(),
          })
          .optional(),
        marketing: toggles.optional(),
      })
      .optional(),
  })
  .refine((patch) => patch.notifications !== undefined, 'Send at least one preference to change');

export type PreferencesPatch = z.output<typeof preferencesPatch>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Recursive merge; `undefined` in the patch leaves the current value. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  // Keys come from the strict patch schema, so `__proto__` and friends can't appear here.
  for (const [key, value] of Object.entries(patch)) merged[key] = deepMerge(base[key], value);
  return merged;
}

export function mergePreferences(
  current: UserPreferences,
  patch: PreferencesPatch,
): UserPreferences {
  return userPreferences.parse(deepMerge(current, patch));
}
