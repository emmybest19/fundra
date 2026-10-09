# Fundra

A production-style fintech backend for a digital NGN wallet platform. It is built around a **double-entry ledger**, so every balance can be explained, every money movement is atomic and idempotent, and duplicate webhooks or concurrent requests can't create or lose money.

Built with Node.js, TypeScript, Express, PostgreSQL, Prisma, Redis and BullMQ as a modular monolith.

> **Status: in development.** The app skeleton runs; business modules are next. See [Status](#status).

---

## What it does

```text
Register → Verify email/phone → KYC → Wallet → Fund → Transfer / Pay → Withdraw → History
```

| Area | Capabilities |
|---|---|
| Auth | Registration, login/logout, JWT access tokens, rotating refresh tokens with reuse detection, email/phone verification, password reset, sessions and devices |
| KYC | Profiles, documents, status lifecycle, admin review, pluggable `KycProvider` (mock first) |
| Wallets & ledger | NGN wallets (multi-currency ready), double-entry ledger, holds, available vs ledger balance, reconciliation |
| Money movement | P2P transfers, deposits, withdrawals, payments, refunds, reversals, fees, all idempotent |
| Payments | Pluggable `PaymentProvider` (mock first, Paystack/Flutterwave sandbox later), signed and deduplicated webhooks |
| Platform | Beneficiaries, async notifications (BullMQ), audit log, RBAC admin API |

Full requirements are in [docs/PROJECT.md](docs/PROJECT.md).

---

## Technology stack

Versions are exactly as installed.

| Concern | Technology | Version |
|---|---|---|
| Runtime | Node.js (LTS) | 24.21.0 |
| Language | TypeScript (strict) | 6.0.3 |
| HTTP | Express | 5.2.1 |
| Database | PostgreSQL (Docker image `postgres:18.6-alpine`) | 18.6 |
| ORM | Prisma + `@prisma/adapter-pg` | 7.10.0 |
| Validation | Zod | 4.6.5 |
| JWT | jose | 6.2.12 |
| Password hashing | argon2 (Argon2id) | 0.45.1 |
| Cache / queues | Redis (Docker image `redis:8.8.3-alpine`) · ioredis · BullMQ | 8.8.3 · 6.0.0 · 6.3.11 |
| Logging | Pino · pino-http · pino-pretty (dev) | 10.3.1 · 11.0.0 · 13.1.3 |
| HTTP security | helmet · cors | 8.3.0 · 2.8.6 |
| Linting | ESLint · typescript-eslint | 10.11.0 · 8.71.0 |
| Formatting | Prettier | 3.9.9 |
| Testing | Vitest · @vitest/coverage-v8 · Supertest | 5.0.3 · 5.0.3 · 7.3.0 |

Planned but not yet installed: Testcontainers, OpenAPI tooling, GitHub Actions. Docker Desktop is required locally (see Getting started).

Why TypeScript 6 and Prisma 7 rather than the newest majors: see [CASE_STUDY.md §5.1](docs/CASE_STUDY.md#51-latest-isnt-always-stable).

---

## Architecture at a glance

```mermaid
flowchart LR
    C[Clients] --> API[API process<br/>Express /api/v1]
    PSP[Payment provider] -- signed webhooks --> API
    API --> PG[(PostgreSQL<br/>source of truth)]
    API --> R[(Redis)]
    W[Worker process<br/>BullMQ] --> PG
    W --> R
```

- **Ledger first:** balances are projections of immutable, balanced ledger entries.
- **Atomic and concurrency-safe:** one DB transaction per money movement, wallets locked in a fixed order.
- **Idempotent:** an `Idempotency-Key` stored in PostgreSQL alongside the money movement; webhooks deduplicated by event ID.
- **Reliable async:** a transactional outbox feeds BullMQ workers.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Project structure

```text
src/
├── config/        environment, database, redis, logger
├── common/        errors, types, utils, validators, constants
├── middleware/    auth, error, rate-limit, request-id, request-logger, security, validation
├── modules/       auth · users · kyc · wallets · ledger · transactions · transfers
│                  payments · beneficiaries · notifications · webhooks · audit · admin
├── jobs/          BullMQ queues and workers
├── routes/        /api/v1 router
├── app.ts         Express app
└── server.ts      entry point
prisma/            schema, migrations, seed
tests/             unit · integration · e2e
docs/              project definition, architecture, case study, API, security
```

---

## Status

| Step | State |
|---|---|
| Requirements | Done ([PROJECT.md](docs/PROJECT.md)) |
| Decisions D1–D6, license | Done ([ARCHITECTURE.md §14](docs/ARCHITECTURE.md#14-decisions)) |
| Architecture | Done ([ARCHITECTURE.md](docs/ARCHITECTURE.md)) |
| Dependencies | Installed |
| Module scaffold | Done; module files hold responsibility comments only |
| Tooling: TypeScript (strict, ESM), scripts, ESLint, Prettier, Vitest | Done |
| App skeleton: config, logging, errors, middleware, server, health, shutdown | Done (108 unit tests) |
| Docker, PostgreSQL, Redis | `docker-compose.yml` written; not yet run (Docker Desktop not installed) |
| Database design, Prisma, schema + first migration | Done ([DATABASE.md](docs/DATABASE.md)); not yet applied to the Docker database |
| Ledger integrity triggers (entries and audit logs append-only, balanced at commit; ledger accounts append-only since Stage 11) | Done (verified on PostgreSQL 18.3 via PGlite) |
| Seed data (roles, permissions, limits, fees, system accounts) | Done |
| Auth (Stage 7): register, login, refresh (rotating, reuse detection), logout, sessions/devices, `authenticate`, email/phone verification, password reset, RBAC `authorize` | Done. Codes aren't delivered until Stage 17 |
| Database readiness check + connection close on shutdown | Done (Stage 5 complete) |
| Shared infrastructure: Redis, rate limiting, validation, audit, idempotency, outbox | Done (Stage 6); the Testcontainers integration suite is deferred until Docker is installed |
| Users (Stage 8): profile, contact change, preferences, status lifecycle, deactivation, password change | Done |
| KYC (Stage 9): `KycProvider` + mock, tiers 1–3, documents, review lifecycle, tier limits | Done. Reviewer endpoints arrive with Admin (Stage 19) |
| Wallets (Stage 10): created with Tier 1 (own ledger account, check-digit account number), status lifecycle, balance endpoints | Done. Freeze/unfreeze endpoints arrive with Admin (Stage 19) |
| Ledger (Stage 11): `ledger.post()` (invariants, ordered wallet locks, status and funds under the lock, cached balances) | In progress (items 1–4 of 5 done; the parallel-debit concurrency test needs real PostgreSQL) |
| Business modules, CI, deployment | Not started |

Stage-by-stage progress: [ROADMAP.md](docs/ROADMAP.md).

Known gaps are listed in [ARCHITECTURE.md §13](docs/ARCHITECTURE.md#13-known-debt-and-current-gaps).

---

## Getting started

Requires **Node.js 24 LTS**. The exact version is pinned in `.nvmrc` (24.21.0), and `npm install` refuses to run on Node versions below 24 (`engines` + `engine-strict`).

```bash
git clone <repo-url> fundra
cd fundra
nvm install 24.21.0 && nvm use 24.21.0
npm install
```

`npm install` runs the install scripts approved in `package.json` (`allowScripts`) for argon2 and Prisma.

Start PostgreSQL and Redis (requires Docker Desktop):

```bash
docker compose up -d     # start in the background
docker compose ps        # both services should show "healthy"
docker compose down      # stop (data is kept)
docker compose down -v   # stop and delete all local data
```

Both services listen on `127.0.0.1` only, so they aren't reachable from your network. `docker-compose.yml` reads these variables from `.env`: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD`, and optionally `POSTGRES_PORT` and `REDIS_PORT`.

Run the API:

```bash
npm run dev                                   # http://localhost:3000, restarts on file changes
curl http://localhost:3000/health/live        # {"status":"ok"}
curl http://localhost:3000/health/ready       # {"status":"ready","checks":{"database":"up","redis":"up"}}
                                              # 200 "degraded" if only Redis is down (rate limiting fails open)
                                              # 503 "unavailable" if PostgreSQL is down
```

Press Ctrl+C to stop gracefully: in-flight requests finish before the process exits.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the API from TypeScript source with auto-restart on changes; loads `.env` |
| `npm run dev:worker` | Same for the background worker process |
| `npm run typecheck` | Type-checks `src`, `tests` and `prisma` (no output files) |
| `npm run build` | Cleans `dist/` and compiles `src/` to JavaScript |
| `npm start` / `npm run start:worker` | Runs the compiled API / worker from `dist/` |
| `npm run clean` | Deletes `dist/` |
| `npm run lint` / `lint:fix` | ESLint (strict, type-aware) / auto-fix what it can |
| `npm run format` / `format:check` | Prettier write / check (Markdown is excluded) |
| `npm test` / `test:watch` | Unit tests (`tests/unit`) once / in watch mode |
| `npm run test:integration` | Integration tests (`tests/integration`), against real PostgreSQL/Redis |
| `npm run test:e2e` | HTTP end-to-end tests (`tests/e2e`) with Supertest |
| `npm run test:all` / `test:coverage` | All three suites / with a v8 coverage report in `coverage/` |

Development runs `.ts` files directly with Node 24's built-in type stripping, so there's no `tsx` or `ts-node`. Because of that, relative imports use the **`.ts`** extension (`import { x } from './x.ts'`). The build rewrites them to `.js`.

Lint rules specific to Fundra:
- no `console`; use the Pino logger
- no `parseFloat`; money is `bigint` kobo
- `process.env` only in `src/config/env.ts`
- `switch` statements over statuses must handle every case

### Database scripts

| Command | What it does |
|---|---|
| `npm run db:generate` | Regenerates the typed Prisma client into `src/generated/` (git-ignored; also runs automatically on `npm install`) |
| `npm run db:migrate` | Creates and applies a migration in development (`prisma migrate dev`) |
| `npm run db:deploy` | Applies pending migrations without prompts (CI, production) |
| `npm run db:status` | Shows which migrations are applied |
| `npm run db:seed` | Seeds roles, permissions, tier limits, fee rules, the mock payment provider and system ledger accounts. Atomic and safe to re-run; admin-edited limits and fees are preserved ([details](docs/DATABASE.md#10-seed-data)) |
| `npm run db:studio` | Opens Prisma Studio to browse data |

Prisma reads its settings from `prisma.config.ts`, which loads `.env` with Node's built-in loader. `db:generate` works without `DATABASE_URL`; the other commands need it.

### Environment variables

Configuration lives in a local `.env` file, which git ignores. `src/config/env.ts` validates it at startup. If anything is missing or invalid, the process refuses to start and lists each bad variable by name. Values are never printed.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` · `test` · `production` |
| `PORT` | no | `3000` | 1–65535 |
| `LOG_LEVEL` | no | `info` (`silent` under test) | `fatal` · `error` · `warn` · `info` · `debug` · `trace` · `silent` |
| `DATABASE_URL` | **yes** | — | `postgresql://user:pass@localhost:5433/fundra?schema=public` (port must match `POSTGRES_PORT`) |
| `REDIS_URL` | **yes** | — | `redis://:pass@localhost:6379` (`rediss://` for TLS) |
| `CORS_ORIGINS` | no | *(empty: no browser origin allowed)* | Comma-separated exact origins, e.g. `https://app.fundra.dev,http://localhost:5173` |
| `TRUST_PROXY_HOPS` | no | `0` | Number of reverse proxies in front of the app (0–10). Keep `0` unless behind a load balancer; otherwise clients could fake their IP with `X-Forwarded-For` |
| `JWT_ACCESS_SECRET` | **yes** | — | Access-token signing key, ≥32 characters of random data. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out of their current access tokens (refresh tokens keep working) |
| `OTP_SECRET` | **yes** | — | HMAC key for one-time codes stored in Redis, ≥32 characters of random data (generate the same way). Must differ from `JWT_ACCESS_SECRET`. Changing it invalidates codes already sent |
| `KYC_ENCRYPTION_KEY` | **yes** | — | AES-256-GCM key for BVN/NIN at rest: exactly 32 random bytes, base64. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Changing it makes stored numbers unreadable |
| `KYC_HMAC_KEY` | **yes** | — | HMAC key for BVN/NIN uniqueness, ≥32 characters of random data; different from the other secrets. Changing it breaks duplicate detection for numbers already stored |
| `KYC_PROVIDER` | no | `mock` | Only `mock` exists. It approves almost anyone, so the server logs a warning at startup |
| `KYC_STORAGE_DIR` | no | `storage/kyc` | Where KYC documents are written (git-ignored). Never served over HTTP |
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` · `REDIS_PASSWORD` | for Docker | — | Read by `docker-compose.yml`, not the app |
| `POSTGRES_PORT` · `REDIS_PORT` | no | `5432` · `6379` | Host ports used by `docker-compose.yml`. Set `POSTGRES_PORT=5433` if another PostgreSQL already uses 5432 (the case on the original dev machine) |

Logs are JSON in production, colourised in development (pino-pretty), and silent in tests. Passwords, tokens, OTPs, PINs, BVN/NIN and auth/cookie headers are replaced with `[REDACTED]`.

---

## Documentation

| Document | Contents |
|---|---|
| [ROADMAP.md](docs/ROADMAP.md) | Stage-by-stage build plan and progress |
| [DATABASE.md](docs/DATABASE.md) | PostgreSQL schema design: tables, keys, indexes, constraints |
| [PROJECT.md](docs/PROJECT.md) | What Fundra is, its requirements and scope |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, ledger, flows, data model, security, known debt |
| [CASE_STUDY.md](docs/CASE_STUDY.md) | Problem, decisions, challenges and trade-offs |
| [api.md](docs/api.md) | Endpoint reference (filled in per module) |
| [security.md](docs/security.md) | Security controls (filled in per module) |

---

## License

[MIT](LICENSE) © 2026 Ebri Emmanuel
