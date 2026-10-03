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
        },
      },
    ],

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
