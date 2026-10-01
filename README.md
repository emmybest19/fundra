# Fundra

A production-style fintech backend for a digital NGN wallet platform. It is built around a **double-entry ledger**, so every balance can be explained, every money movement is atomic and idempotent, and duplicate webhooks or concurrent requests can't create or lose money.

Built with Node.js, TypeScript, Express, PostgreSQL, Prisma, Redis and BullMQ as a modular monolith.

> **Status: design complete, implementation not started.** See [Status](#status).

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

Planned but not yet installed: ESLint, Prettier, Vitest, Supertest, Testcontainers, OpenAPI tooling, Docker, GitHub Actions.

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
├── middleware/    auth, error, rate-limit, request-id, validation
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
| Module scaffold | Done; files hold responsibility comments only |
| Database/ERD, ledger design, API spec | Next |
| TypeScript config, scripts, Prisma config | Not started |
| Docker, PostgreSQL, Redis | `docker-compose.yml` written; not yet run (Docker Desktop not installed) |
| Modules, tests, CI, deployment | Not started |

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

Commands for migrations and for starting the API, workers and tests will be added here as each piece is built.

Configuration lives in a local `.env` file, which git ignores. Required variables will be validated at startup by `src/config/env.ts`.

---

## Documentation

| Document | Contents |
|---|---|
| [ROADMAP.md](docs/ROADMAP.md) | Stage-by-stage build plan and progress |
| [PROJECT.md](docs/PROJECT.md) | What Fundra is, its requirements and scope |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, ledger, flows, data model, security, known debt |
| [CASE_STUDY.md](docs/CASE_STUDY.md) | Problem, decisions, challenges and trade-offs |
| [api.md](docs/api.md) | Endpoint reference (filled in per module) |
| [security.md](docs/security.md) | Security controls (filled in per module) |

---

## License

[MIT](LICENSE) © 2026 Ebri Emmanuel
