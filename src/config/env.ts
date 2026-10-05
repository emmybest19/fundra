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
  // HS256 signing key for access tokens. At least 32 characters of random data
  // (e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`).
  JWT_ACCESS_SECRET: z.string().min(32, 'Must be at least 32 characters of random data'),
  // HMAC key for one-time codes stored in Redis; a separate key from JWT_ACCESS_SECRET.
  OTP_SECRET: z.string().min(32, 'Must be at least 32 characters of random data'),
  // Identity-verification provider (Stage 9). Only the mock exists; it approves almost anyone,
  // so the server logs a warning at startup and every decision records provider MOCK.
  KYC_PROVIDER: z.enum(['mock']).default('mock'),
  // AES-256-GCM key for BVN/NIN at rest: exactly 32 bytes, base64
  // (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
  KYC_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 32,
      'Must be exactly 32 random bytes, base64-encoded',
    ),
  // HMAC key for BVN/NIN uniqueness lookups; a separate key from KYC_ENCRYPTION_KEY.
  KYC_HMAC_KEY: z.string().min(32, 'Must be at least 32 characters of random data'),
  // Where KYC documents are stored (local disk until S3, Stage 25). Never served over HTTP.
  KYC_STORAGE_DIR: z.string().default('storage/kyc'),
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
