// Prisma CLI configuration (migrate, generate, seed, studio).
import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 doesn't read .env itself. Node's built-in loader avoids a dotenv dependency;
// in CI and containers the variables come from the environment and there is no file.
if (existsSync('.env')) process.loadEnvFile('.env');

// `prisma generate` needs no database, so a missing URL must not block it (CI, Docker builds).
// Commands that connect (migrate, studio) fail with Prisma's own error when it is absent.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.ts',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
