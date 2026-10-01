// Loads and validates environment variables (Zod); the only place process.env is read.
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Comma-separated list of exact browser origins, e.g. `https://app.fundra.dev,http://localhost:5173`. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(
    z.array(
      z.string().refine(isOrigin, 'Each entry must be an origin like https://app.example.com'),
    ),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Empty by default: no browser origin may call the API until one is listed.
  CORS_ORIGINS: originList.default([]),
  // Number of reverse proxies in front of the app. 0 trusts none, so X-Forwarded-For can't spoof client IPs.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  // `KEY=` in a .env file means "not set", so defaults and required checks still apply.
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = envSchema.safeParse(present);
  if (!result.success) {
    // Report the variable and the problem, never the value: it may be a secret.
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }
  return Object.freeze(result.data);
}

export const env = parseEnv(process.env);
