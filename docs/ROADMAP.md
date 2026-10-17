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

### Stage 5 — Database design ✅
- [x] ERD: all entities, keys, indexes, constraints ([DATABASE.md](DATABASE.md), 26 tables)
- [x] Prisma 7 setup (`prisma.config.ts`, adapter-pg) + `config/database.ts` (real connection test pending Docker)
- [x] Full schema + first migration (26 tables, 41 CHECKs, 7 partial indexes; verified on PostgreSQL 18.3 via PGlite, apply to Docker DB pending)
- [x] Ledger triggers (no update/delete/truncate, balanced at commit; 19 checks on PostgreSQL 18.3 via PGlite)
- [x] Seed: roles, permissions, system ledger accounts (+ tier limits, fee rule, MOCK provider; atomic, re-runnable; verified via pglite-socket)
- [x] Register the `database` readiness check + close Prisma on shutdown (live down/up/down/up test passed)

### Stage 6 — Shared infrastructure (items 1–6 ✅; item 7 deferred until Docker is installed)
- [x] `config/redis.ts` + rate-limit middleware (global 300/min per IP; Lua verified on ioredis-mock, real Redis pending Docker)
- [x] Register the `redis` readiness check + close Redis on shutdown (non-critical → `degraded`; verified live)
- [x] Validation middleware (Zod): typed `validated()` wrapper + shared validators (amount, currency, uuid, pagination)
- [x] Audit service (transactional, sanitized metadata; append-only errors now `FN001`, verified via Prisma)
- [x] Idempotency service (claim → fenced transaction → complete; 20/21 scenarios on PostgreSQL 18.3; schema drift check now clean)
- [x] Outbox writer (typed event catalogue, transactional; verified incl. no duplicate event on idempotent replay)
- [ ] Testcontainers harness for integration tests: **deferred (2026-10-02), needs Docker Desktop**. Until then, database behaviour is verified with scratch scripts on PGlite (PostgreSQL 18.3); the items below are what this suite must cover
- [ ] Port the 49 migration checks from Stage 5 (30 constraints + 19 triggers) into integration tests
- [ ] Integration test for the rate-limit Lua script on real Redis 8.8 (counting, expiry, TTL repair, concurrency)
- [ ] Integration tests for idempotency on real PostgreSQL: all 10 scenarios, plus true concurrency (N parallel requests → one execution) and row-lock waits during takeover
- [ ] Row-lock races on real PostgreSQL (PGlite serialises connections): concurrent preference PATCHes lose nothing; a name change racing a KYC submit; deactivation racing an incoming posting; two accounts racing Tier 2 with the same BVN (the HMAC unique index turns the loser into a `DUPLICATE_IDENTITY` rejection; PGlite's socket server can't run this, because it answers the first query after a failed transaction with the previous query's response)
- [ ] CI check: `prisma migrate diff` between migrations and schema must be empty (no drift)

### Stage 7 — Auth ✅
- [x] Register + Argon2id password hashing + credential-verification core (lockout, timing-safe, rehash); verified end-to-end on PostgreSQL 18.3
- [x] Login, refresh, logout endpoints: access tokens + rotating refresh tokens with reuse detection (23/23 lifecycle checks over HTTP on PostgreSQL 18.3)
- [x] Sessions + devices (list / revoke one / revoke others, new-device detection) + `authenticate` middleware (pulled forward from item 5; per-request session check makes revocation immediate)
- [x] Email/phone verification (OTP → `ACTIVE`), password reset (signs out everywhere, clears lockout); `redis` readiness kept non-critical, OTP store fails closed (503). 26/26 behaviours on PostgreSQL 18.3; Lua verified on ioredis-mock
- [x] `authorize(permission)` middleware (RBAC) + `requireActiveAccount`; roles loaded from the database per request (grant/revoke immediate); verified on PostgreSQL 18.3

### Stage 8 — Users ✅
- [x] Profile, contact info, preferences, status, deactivation: name locks at KYC submission, contact change via a code bound to the new address, password re-check for sensitive actions, deactivation (zero balance, nothing pending, wallets closed, sessions revoked); 54/54 checks on PostgreSQL 18.3
- [x] Change password while signed in (`POST /users/me/password`): current password re-checked with the shared lockout; every session revoked and a fresh one opened for this device, so all old tokens die; 23/23 checks on PostgreSQL 18.3

### Stage 9 — KYC ✅
- [x] `KycProvider` interface + `MockKycProvider`: identity-number check (verdict only, shared name-matching rule), async document check, magic-number mock; 18 unit tests
- [x] KYC profile, documents, status lifecycle: Tier 1 (DOB, 18+) and Tier 2 (BVN/NIN via provider, encrypted + HMAC, generic rejection) decided at once; Tier 3 documents (magic-byte checked, local storage) + address → review (open → approve/reject, provider must accept, no self-review); Stage 8 name-lock fix; 59/59 checks on PostgreSQL 18.3
- [x] Tier → limits mapping: `findTierLimits` (fails closed on a missing row), `checkOutflow` (amount + fee, Lagos day) / `checkInflow` (refunds and reversals exempt), limit errors that never reveal a recipient's limits, limits in `GET /kyc`; 9 checks on PostgreSQL 18.3. Applied by Stages 13–14

### Stage 10 — Wallets ✅
- [x] Wallet created on KYC approval: NGN wallet + `WALLET:<id>` LIABILITY ledger account in the Tier 1 approval transaction (atomic, proven by DB fault injection); idempotent; account number = 9 random digits + Damm check digit; 15/15 checks on PostgreSQL 18.3
- [x] Wallet status + balance endpoints: `GET /wallets`, `GET /wallets/:id` (own only, 404 otherwise, no-store); status lifecycle table (`ACTIVE ⇄ FROZEN → CLOSED`, reopen only after reactivation), freeze/unfreeze/reopen service methods (reason audited only, no self-action), deactivation routed through it; 26 checks on PostgreSQL 18.3

### Stage 11 — Ledger
- [x] `ledger.post()`: invariants, ordered row locks, balance check, entries, cached balances; reject `CLOSED` wallets and `FROZEN` ones (except reversals and refunds) under the wallet lock. One posting per transaction; `lockWallets` for limit checks under the lock; 25 checks on PostgreSQL 18.3, DB backstops proven by code breaks
- [x] Make `ledger_accounts.code/type/currency` immutable once created: whole table append-only (`UPDATE`/`DELETE`/`TRUNCATE` → `FN001`, `INSERT` allowed), migration `*_ledger_accounts_append_only`; also blocks a currency change cascading into the wallet; 14 checks on PostgreSQL 18.3
- [x] Translate database errors at the service boundary: classifier by SQLSTATE (Prisma codes proved unreliable), unbalanced ledger now `FN002` (COMMIT errors lose the constraint name), services match constraint names, fallback 409/503/500 with nothing leaked; 18 real-error checks on PostgreSQL 18.3
- [x] Holds (place / settle / release): available-only reservation, exact settlement through `post()` (allowed if frozen mid-flight), release always allowed, `post()` refuses held transactions; invariant available = ledger − active holds; 22 checks on PostgreSQL 18.3
- [ ] **Concurrency test:** parallel debits never overdraw, ledger always balances. **Deferred (2026-10-14): needs real PostgreSQL (Docker)**; PGlite serves every connection from one backend, so it can't run postings in parallel. Belongs with the Stage 6 Testcontainers suite

### Stage 12 — Transactions ✅
- [x] Transaction record, references, status state machine: creation with per-type shape checks and reversal mirroring, Lagos-dated references, transition table (+ instant `PENDING → COMPLETED/FAILED`) with posting/hold checks per status; 32 checks on PostgreSQL 18.3
- [x] History endpoints (cursor pagination, filters): `GET /transactions` (keyset on created_at+id, opaque cursor, wallet/type/status/direction/date filters) and `GET /transactions/:id`; caller-side view; another user's money visible only once it arrived; 21 checks over HTTP on PostgreSQL 18.3

### Stage 13 — Transfers ✅
- [x] `POST /transfers`: checks, limits, idempotency, atomic posting, fees. Plus `GET /transfers/recipient` (D2 lookup, check-digit typo refusal, rate-limited); limits checked under the wallet locks (daily outflow summed under the sender's lock); recipient refusals generic; deadlocks retried ×3; 26 checks over HTTP on PostgreSQL 18.3
- [x] Reversals: admin service (`transactions:reverse`; endpoint in Stage 19) for completed transfers: REVERSAL + separate fee REFUND, original → REVERSED, exempt from limits and freezes but never overdraws, no self-action; 16 checks on PostgreSQL 18.3

### Stage 14 — Payments ✅
- [x] `PaymentProvider` interface + `MockPaymentProvider`: deposits, name enquiry, payouts, status, webhook verify/parse; reference-idempotent; Paystack-shaped signed webhooks from test hooks; 31 tests
- [x] Deposits (pending → webhook completes): `POST /payments/deposits` (idempotent; provider called inside the transaction, nothing kept on outage) and `applyEvent` (row-locked, exactly once; mismatches, late news, frozen wallets and max balance held for review, never credited); 28 checks on PostgreSQL 18.3
- [x] Withdrawals (hold → payout → settle/release): name enquiry; `POST /payments/withdrawals` holds amount + ₦10 fee and commits before the payout is sent; `dispatch` is retry-safe; `applyEvent` settles or releases (matched by our reference if the webhook wins the race); 32 checks on PostgreSQL 18.3
- [x] Payments + refunds: bill payments (`GET /payments/billers`, `POST /payments/bills`) through the same hold → dispatch → settle/release service as withdrawals; biller refunds as separate REFUND transactions (partial, deduplicated by refund reference, capped at what was paid); 26 checks on PostgreSQL 18.3

### Stage 15 — Webhooks ✅
- [x] Raw-body route, HMAC verification, event-ID dedupe, persistence: `POST /webhooks/payments` before JSON parsing; 401 and nothing stored on a bad signature; unique (provider, event ID) makes replays `200 DUPLICATE`; unknown types stored `IGNORED`; 12 checks on PostgreSQL 18.3
- [x] `process-webhook` dispatch to payments: stored payload → deposits / payouts / bills / refunds; outcome recorded on the event (PROCESSED, review noted, FAILED + attempts for retry); inline until Stage 16, `processPending()` ready for the job; 15 end-to-end checks on PostgreSQL 18.3

### Stage 16 — Background jobs ✅ (real-Redis run deferred)
- [x] Queues + worker process (`jobs/workers.ts`); close queues first in shutdown cleanup; webhooks handed to the worker (job ID = event ID, inline fallback, 30 s sweep); queue connection pinned to RESP2; 12 checks with real BullMQ on its PostgreSQL backend (PGlite). **Deferred:** confirming BullMQ on a real Redis 8 server (needs Redis installed)
- [x] Outbox relay (`SELECT … FOR UPDATE SKIP LOCKED` batches, job ID = event ID, increment `attempts`, mark `published_at`): every second; failures wait for the next run without holding back the batch; a lost COMMIT re-queues as the same job; 11 checks with real BullMQ
- [x] `expire-otp`: OTPs already expire by Redis TTL (set atomically with the code); the hourly job purges expired idempotency keys in bounded batches; 6 checks on PostgreSQL 18.3

### Stage 17 — Notifications ✅
- [x] Notification records + email/SMS/push jobs (mock senders): one set per event (advisory lock), channels by preference, `send-email/sms/push` (job ID = notification ID, FAILED after the last retry), `requeue-notifications` sweep, in-app feed API; 18 checks with real BullMQ
- [x] Wire up events: transfers, deposits, withdrawals, logins, KYC, security: every outbox event mapped to finished text per user (transfers and reversals tell both sides; new-device sign-ins only; no second password email; freeze reasons never shown); 10 end-to-end checks + 19 unit tests

### Stage 18 — Beneficiaries ✅
- [x] CRUD with ownership checks + audit: Fundra wallets (D2 lookup) and bank accounts (name enquiry); owner-scoped queries (404 otherwise); nickname-only updates (no silent repointing); duplicates, self and a 100 cap refused; masked audit; 19 checks on PostgreSQL 18.3

### Stage 19 — Admin ✅
- [x] Users (view/suspend/reactivate), KYC review (`KycService.startReview/approve/reject` exist), transactions, wallets (`WalletService.freeze/unfreeze/reopen` exist), audit logs, settings: `/admin/*` built from one route table (each with its permission); no self-action, staff accounts protected, reactivation reopens wallets; fee history kept; 34 checks on PostgreSQL 18.3
- [x] Per-permission protection: role assignment (`roles:assign`; never yourself, never the last super admin; effective on the next request); every route × every role tested through the real router (176 cases) plus a pinned route → permission spec

### Stage 20 — Reconciliation & statements ✅
- [x] `reconcile-transactions`: wallet cache vs ledger, drift alerts: hourly and on demand (`GET /admin/reconciliation`); one snapshot; balances, holds, global balance and invariants; reports and audits, never auto-corrects; 10 checks on PostgreSQL 18.3
- [x] `generate-statement`: `POST /statements` → job → CSV from the ledger (opening, entries with running balance, closing; CSV-injection safe) → `statement.ready` notification → owner-only download; new `statements` table (migration via `prisma migrate diff`); 15 checks on PostgreSQL 18.3

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
