import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Safe, fake values so src/config/env.ts validates under test. Never real credentials.
    // Integration tests override the URLs with their Testcontainers instances.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://fundra:test@localhost:5432/fundra_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'test-only-access-token-secret-not-for-production-use',
      OTP_SECRET: 'test-only-otp-hmac-secret-not-for-production-use-ok',
      KYC_ENCRYPTION_KEY: 'dGVzdC1vbmx5LWt5Yy1lbmNyeXB0aW9uLWtleS0zMmI=',
      KYC_HMAC_KEY: 'test-only-kyc-hmac-secret-not-for-production-use',
      PAYMENT_WEBHOOK_SECRET: 'test-only-payment-webhook-secret-not-for-production',
    },
    // Each test starts from a clean slate of mocks, spies and stubbed env vars.
    restoreMocks: true,
    unstubEnvs: true,
    // Test folders start empty; remove once every project has tests.
    passWithNoTests: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Real PostgreSQL/Redis (Testcontainers) start slower than in-memory code.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // One file at a time: each starts its own in-process PostgreSQL (WebAssembly), and
          // several at once starve each other (and the unit tests) of CPU.
          fileParallelism: false,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // A floor just under today's numbers (lines 87%, statements 84%): coverage can rise, not
      // quietly fall. Most of what's left is process wiring (server and worker entry points,
      // the live Redis client, signal handling) that the Docker integration suite will run.
      thresholds: { lines: 85, statements: 82, functions: 85, branches: 70 },
    },
  },
});
