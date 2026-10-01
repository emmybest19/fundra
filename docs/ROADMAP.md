# Fundra — Roadmap

Build order, one stage at a time. Say **"do stage N"** to start a stage. Each stage follows the method in [PROJECT.md §9](PROJECT.md#9-delivery-approach): design → API contract → security/money considerations → code → tests → how to verify → commit message.

Legend: `[x]` done · `[ ]` to do

---

### Stage 0 — Foundation ✅
- [x] Requirements ([PROJECT.md](PROJECT.md))
- [x] Architecture ([ARCHITECTURE.md](ARCHITECTURE.md))
- [x] Node 24 LTS + core dependencies installed
- [x] Folder scaffold + docs

### Stage 1 — Decisions ✅
- [x] Confirm D1–D6 ([ARCHITECTURE.md §14](ARCHITECTURE.md#14-decisions))
- [x] Choose a license (MIT)

### Stage 2 — Dev environment
- [ ] Install Docker Desktop
- [x] `docker-compose.yml`: PostgreSQL 18.6 + Redis 8.8.3 (written; first `docker compose up` pending Docker)
- [x] `.nvmrc` + `engines` in package.json (enforced via `.npmrc` `engine-strict`)

### Stage 3 — Tooling ✅
- [x] `tsconfig.json` (strict) + `tsconfig.build.json`; project switched to ES modules
- [x] npm scripts: `dev`, `dev:worker`, `build`, `clean`, `start`, `start:worker`, `typecheck` (Node 24 runs `.ts` natively; no tsx/ts-node)
- [x] ESLint 10 (strict type-checked + money/config rules) + Prettier 3 (+ `lint`, `format` scripts)
- [x] Vitest 5 (unit / integration / e2e projects, v8 coverage) + Supertest (+ `test` scripts)

### Stage 4 — App skeleton ✅
- [x] `config/env.ts` (Zod-validated env), `config/logger.ts` (Pino + redaction), 24 unit tests
- [x] `common/errors` (error classes, code catalogue, `normalizeError`) + response envelope, 35 unit tests
- [x] Request-ID, request logger, error and 404 middleware; helmet, CORS allow-list, 100 kB JSON limit
- [x] `app.ts`, `server.ts`, graceful shutdown, `/health/live` + `/health/ready` (readiness checks registered in Stages 5–6)

### Stage 5 — Database design
- [x] ERD: all entities, keys, indexes, constraints ([DATABASE.md](DATABASE.md), 26 tables)
- [x] Prisma 7 setup (`prisma.config.ts`, adapter-pg) + `config/database.ts` (real connection test pending Docker)
- [x] Full schema + first migration (26 tables, 41 CHECKs, 7 partial indexes; verified on PostgreSQL 18.3 via PGlite, apply to Docker DB pending)
- [x] Ledger triggers (no update/delete/truncate, balanced at commit; 19 checks on PostgreSQL 18.3 via PGlite)
- [ ] Seed: roles, permissions, system ledger accounts
- [ ] Register the `database` readiness check + close Prisma on shutdown

### Stage 6 — Shared infrastructure
- [ ] `config/redis.ts` + rate-limit middleware
- [ ] Register the `redis` readiness check + close Redis on shutdown
- [ ] Validation middleware (Zod)
- [ ] Audit service
- [ ] Idempotency service
- [ ] Outbox writer
- [ ] Testcontainers harness for integration tests
- [ ] Port the 49 migration checks from Stage 5 (30 constraints + 19 triggers) into integration tests

### Stage 7 — Auth
- [ ] Register, login, logout (Argon2id)
- [ ] Access tokens + rotating refresh tokens with reuse detection
- [ ] Sessions + devices
- [ ] Email/phone verification (OTP), password reset
- [ ] `authenticate` + `authorize(permission)` middleware (RBAC)

### Stage 8 — Users
- [ ] Profile, contact info, preferences, status, deactivation

### Stage 9 — KYC
- [ ] `KycProvider` interface + `MockKycProvider`
- [ ] KYC profile, documents, status lifecycle
- [ ] Tier → limits mapping

### Stage 10 — Wallets
- [ ] Wallet created on KYC approval
- [ ] Wallet status + balance endpoints

### Stage 11 — Ledger
- [ ] `ledger.post()`: invariants, ordered row locks, balance check, entries, cached balances
- [ ] Holds (place / settle / release)
- [ ] **Concurrency test:** parallel debits never overdraw, ledger always balances

### Stage 12 — Transactions
- [ ] Transaction record, references, status state machine
- [ ] History endpoints (cursor pagination, filters)

### Stage 13 — Transfers
- [ ] `POST /transfers`: checks, limits, idempotency, atomic posting, fees
- [ ] Reversals

### Stage 14 — Payments
- [ ] `PaymentProvider` interface + `MockPaymentProvider`
- [ ] Deposits (pending → webhook completes)
- [ ] Withdrawals (hold → payout → settle/release)
- [ ] Payments + refunds

### Stage 15 — Webhooks
- [ ] Raw-body route, HMAC verification, event-ID dedupe, persistence
- [ ] `process-webhook` dispatch to payments

### Stage 16 — Background jobs
- [ ] Queues + worker process (`jobs/workers.ts`)
- [ ] Outbox relay
- [ ] `expire-otp`

### Stage 17 — Notifications
- [ ] Notification records + email/SMS/push jobs (mock senders)
- [ ] Wire up events: transfers, deposits, withdrawals, logins, KYC, security

### Stage 18 — Beneficiaries
- [ ] CRUD with ownership checks + audit

### Stage 19 — Admin
- [ ] Users (view/suspend), KYC review, transactions, wallets, audit logs, settings
- [ ] Per-permission protection

### Stage 20 — Reconciliation & statements
- [ ] `reconcile-transactions`: wallet cache vs ledger, drift alerts
- [ ] `generate-statement`

### Stage 21 — API docs
- [ ] OpenAPI generated from Zod + Swagger UI
- [ ] Fill in [api.md](api.md)

### Stage 22 — End-to-end testing
- [ ] E2E: register → KYC → fund → transfer → withdraw → history
- [ ] Coverage report; close the gaps

### Stage 23 — Containerise the app
- [ ] Multi-stage `Dockerfile` (API + worker)
- [ ] Add api + worker to `docker-compose.yml`

### Stage 24 — CI
- [ ] GitHub Actions: install → lint → typecheck → unit → integration → build

### Stage 25 — Deployment
- [ ] AWS: app hosting, managed Postgres, Redis, S3 for KYC docs, logs
- [ ] Production config + secrets
- [ ] App connects as a non-owner DB role (no `TRUNCATE`/`ALTER`), so ledger triggers can't be disabled from the app

### Stage 26 — Final documentation
- [ ] Fill in [security.md](security.md)
- [ ] PERFORMANCE.md (measured), LESSONS-LEARNT.md
- [ ] Case study results + README setup instructions
