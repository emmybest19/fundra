# Fundra Architecture

## 1. Overview

Fundra is a fintech backend for a fictional digital financial platform. Users register, complete KYC, get an NGN wallet, fund it, send money to other users, make payments and withdraw funds.

One principle shapes the whole design: **the double-entry ledger is the financial source of truth.** Every other module either controls access to money movement (auth, KYC, limits), triggers it (transfers, payments, webhooks), records it (ledger, transactions) or reports on it (notifications, audit, admin).

### Goals

| Goal | What it means in practice |
|---|---|
| Correctness | Ledger always balances; no lost or duplicated money under retries, crashes or concurrency |
| Auditability | Every balance can be explained by immutable ledger entries; sensitive actions are audit-logged |
| Security | Defence in depth: authentication, RBAC, validation, rate limiting, signed webhooks, secret-free logs |
| Maintainability | One developer can understand, run and change the system |
| Evolvability | Additional currencies, payment providers and KYC providers can be added without rewrites |

### Non-goals (for now)

- Microservices, event sourcing, CQRS
- Foreign exchange / multi-currency transactions
- Real money or real identity verification (mock / sandbox providers only)

---

## 2. Architectural style: modular monolith

Fundra is a single deployable Node.js codebase split into feature modules with explicit boundaries. It runs as **two processes from the same build**:

```text
                ┌───────────────────────────────┐
  Clients ─────▶│  API process  (src/server.ts) │──┐
  Providers ───▶│  Express, /api/v1             │  │
  (webhooks)    └───────────────────────────────┘  │
                                                    ├──▶ PostgreSQL  (source of truth)
                ┌───────────────────────────────┐  │
                │ Worker process (jobs/workers) │──┤
                │ BullMQ consumers              │  │
                └───────────────────────────────┘  └──▶ Redis  (cache, rate limits,
                                                               OTP, locks, queues)
```

- **API process** handles HTTP. It never does slow work (email, SMS, provider polling) inline.
- **Worker process** consumes BullMQ jobs: notifications, webhook processing, the outbox relay, reconciliation and statements.

Both processes share the modules' services, so business rules live in one place.

Why a monolith: one database transaction can span wallet, ledger, transaction and audit writes. That gives atomicity without distributed transactions, which matters more in a financial system than independent scaling.

---

## 3. Layers and dependency rules

```text
routes ──▶ middleware ──▶ controller ──▶ service ──▶ repository / Prisma ──▶ PostgreSQL
                                           │
                                           └──▶ other modules' services
```

| Layer | Responsibility | Must not |
|---|---|---|
| `*.routes.ts` | Map HTTP method + path to middleware chain and controller | Contain logic |
| `*.schema.ts` | Zod schemas for body, query, params and responses | Touch the database |
| `*.controller.ts` | Read the validated request, call one service method, shape the response and status code | Contain business rules or start DB transactions |
| `*.service.ts` | Business rules, orchestration, transaction boundaries | Know about `req`/`res` |
| `*.repository.ts` | Non-trivial persistence (raw SQL, locking). Only where needed, e.g. the ledger | Contain business rules |
| `*.types.ts` | Module types and DTOs | |

### Rules

1. **Modules talk through services, not tables.** `transfers` calls `ledger.service` and `wallet.service`; it never writes `ledger_entries` directly.
2. **Only `ledger.service` writes ledger entries and updates wallet balances.** This is the single enforcement point for "debits = credits".
3. **Transaction boundaries belong to the orchestrating service** (e.g. `transfer.service`). It opens the Prisma interactive transaction and passes the transaction client (`tx`) to the services it calls.
4. **No circular module dependencies.** Lower-level modules (ledger, audit, wallets) never import higher-level ones (transfers, payments, admin).
5. **`config/` is the only reader of `process.env`.** Everything else imports typed config.
6. **Most services use Prisma directly.** A repository is added only where the queries justify it (the ledger needs `SELECT … FOR UPDATE` via raw SQL), to avoid needless abstraction.

### Module dependency direction

```text
admin ─────────────────────────────────────────────┐
webhooks ──▶ payments ──┐                          │
transfers ──────────────┼──▶ transactions ──▶ ledger ──▶ wallets
                        │                          │
kyc ──▶ users ◀── auth  │                          ▼
beneficiaries ──▶ users │                  audit, notifications (leaf modules)
```

---

## 4. Module catalogue

| Module | Responsibility | Main entities owned |
|---|---|---|
| auth | Register, login, logout, tokens, refresh-token rotation, email/phone verification, password reset, sessions, devices | Session, RefreshToken |
| users | Profile, contact info, preferences, status, deactivation | User |
| kyc | KYC profile, documents, provider abstraction, status lifecycle | KycProfile, KycDocument |
| wallets | Wallet lifecycle (created on KYC approval), status, balance reads | Wallet |
| ledger | Balanced postings, ledger accounts (user + system), holds, balance integrity | LedgerAccount, LedgerEntry, Hold |
| transactions | Central transaction record, references, statuses, history queries | Transaction |
| transfers | P2P transfer orchestration | Transfer |
| payments | Deposits, withdrawals and payments via the `PaymentProvider` abstraction | Payment, PaymentProvider |
| webhooks | Receive, verify, deduplicate, persist and dispatch provider events | WebhookEvent |
| beneficiaries | Saved recipients | Beneficiary |
| notifications | Notification records and async delivery (email/SMS/push) | Notification |
| audit | Append-only audit trail | AuditLog |
| admin | Admin use cases over other modules, RBAC-protected | Role, Permission (shared with auth) |

---

## 5. Request lifecycle

Middleware order in `app.ts`:

```text
1.  request-id           assign/propagate X-Request-Id, child logger
2.  pino-http            structured access log (redacted)
3.  helmet               security headers
4.  cors                 explicit origin allow-list
5.  webhooks router      mounted BEFORE json parsing: needs the raw body for signatures
6.  express.json         with a size limit
7.  rate-limit           Redis-backed, per IP and per user, stricter on auth routes
8.  /api/v1 router       per route: auth → authorize(permission) → validate(schema) → controller
9.  404 handler
10. error middleware     maps errors to the standard error response
```

---

## 6. Financial core

### 6.1 Money representation

- Stored as **integer minor units (kobo)** in PostgreSQL `BIGINT` and handled as `bigint` in TypeScript. Never JavaScript `number` floats.
- Every amount carries a **currency** (ISO 4217, `NGN` initially).
- JSON cannot carry `bigint`, so the API returns amounts as **strings of minor units** (e.g. `"1000000"` = ₦10,000.00). See [open decision D1](#15-open-decisions).

### 6.2 Ledger model

```text
LedgerAccount   one per wallet (user funds) + system accounts
  ├─ id, code, type (ASSET | LIABILITY | REVENUE | EXPENSE), currency
  └─ normal balance side derived from type

LedgerEntry     immutable, append-only
  ├─ transactionId, ledgerAccountId
  ├─ direction (DEBIT | CREDIT), amount (> 0), currency
  └─ createdAt
```

From the platform's point of view, a user's wallet balance is money Fundra **owes** the user, so wallet ledger accounts are **liabilities** (credit-normal). System accounts provide the other side of postings that involve the outside world:

| System account | Type | Used for |
|---|---|---|
| `PROVIDER_SETTLEMENT:<provider>` | Asset | Money held at / owed by a payment provider (deposits in, withdrawals out) |
| `FEE_REVENUE` | Revenue | Fees charged |
| `SUSPENSE` | Liability | Money that cannot yet be attributed (investigated by admins) |

### 6.3 Ledger invariants (enforced in code and in the database)

1. Each ledger transaction's entries sum to zero: Σ debits = Σ credits.
2. All entries in one transaction share one currency.
3. Entries are never updated or deleted. Corrections are new, opposite postings (`REVERSAL`, `REFUND`) linked to the original transaction.
4. Amounts are strictly positive. Direction carries the sign.

The database enforces rule 3 with a trigger that blocks `UPDATE`/`DELETE` on `ledger_entries`, and rule 1 with a deferred constraint trigger at commit. The application enforces them too, so failures produce clear errors.

### 6.4 Example postings

| Operation | Debit | Credit |
|---|---|---|
| Deposit ₦10,000 | Provider settlement (asset ↑) 10,000 | User wallet (liability ↑) 10,000 |
| Transfer A → B ₦10,000 | Wallet A 10,000 | Wallet B 10,000 |
| Transfer with ₦50 fee | Wallet A 10,050 | Wallet B 10,000; Fee revenue 50 |
| Withdrawal ₦5,000 (settled) | User wallet 5,000 | Provider settlement 5,000 |
| Reversal of a transfer | Wallet B 10,000 | Wallet A 10,000 |

### 6.5 Balances and holds

- **Ledger balance** = sum of posted entries for the wallet's ledger account.
- **Available balance** = ledger balance − active holds.
- A **Hold** reserves funds for in-flight operations (e.g. a withdrawal awaiting the provider). It is released on failure or settled (converted into postings) on success.
- `Wallet.ledgerBalance` and `Wallet.availableBalance` are **cached projections**. They are updated in the same DB transaction as the entries, for fast reads and balance checks. The `reconcile-transactions` job recomputes them from the ledger and alerts on any drift.

### 6.6 Concurrency

Two simultaneous debits from the same wallet must not both pass the balance check.

- Every money-moving operation runs in a Prisma **interactive transaction**.
- The wallets involved are locked with `SELECT … FOR UPDATE` (raw SQL in `ledger.repository.ts`), **in ascending wallet-ID order** so two opposing transfers cannot deadlock.
- The available balance is checked **after** acquiring the lock.
- Transactions use a short timeout. A lock conflict or serialization failure is retried a bounded number of times, which is safe because of idempotency.

### 6.7 The posting API

The rest of the system moves money through a single function:

```text
ledger.post(tx, {
  transactionId,
  entries: [{ account, direction, amount }, ...],
})
  → validate invariants → lock accounts → check funds → insert entries → update cached balances
```

### 6.8 Transaction records

`Transaction` is the business-level record (type, status, reference, amount, initiator, idempotency key). Ledger entries reference it. Type-specific details live in `Transfer` and `Payment` (one-to-one with `Transaction`).

```text
Types:    DEPOSIT, WITHDRAWAL, TRANSFER, PAYMENT, REFUND, FEE, REVERSAL
Statuses: PENDING → PROCESSING → COMPLETED
                             ↘ FAILED
          PENDING → CANCELLED
          COMPLETED → REVERSED   (via a linked REVERSAL transaction)
```

Status changes are enforced by an explicit transition table in `transaction.service`.

References look like `FND-TRX-YYYYMMDD-XXXXXX`. They have a unique index and are regenerated on the rare collision.

---

## 7. Key flows

### 7.1 P2P transfer (synchronous, single DB transaction)

```text
POST /api/v1/transfers  (Idempotency-Key header required)
 1. auth + validate body
 2. idempotency: same key + same request hash → return the stored response
                 same key + different hash   → 422
 3. checks: sender/recipient status, KYC tier, wallet status, limits
 4. BEGIN
      insert Transaction (PROCESSING) + Transfer + idempotency record
      ledger.post (locks wallets, checks balance, writes entries, updates balances)
      Transaction → COMPLETED
      insert AuditLog
      insert OutboxEvent(transfer.completed)
    COMMIT
 5. store the response against the idempotency key; return 201
```

### 7.2 Deposit (asynchronous, provider-driven)

```text
POST /payments/deposits → Transaction PENDING, Payment created, provider.initialize()
                        → return checkout/reference details to the client
provider webhook (success) → verify, dedupe → BEGIN
                               ledger.post(Dr provider settlement, Cr wallet)
                               Transaction COMPLETED, outbox event
                             COMMIT
```

The webhook is the authority for the deposit outcome, not the client's redirect.

### 7.3 Withdrawal

```text
POST /payments/withdrawals → BEGIN: Transaction PENDING, create Hold (reduces available balance) COMMIT
                           → provider.payout()
webhook success → BEGIN: ledger.post(Dr wallet, Cr provider settlement), release hold, COMPLETED COMMIT
webhook failure → BEGIN: release hold, FAILED COMMIT
```

### 7.4 Webhook ingestion

```text
POST /api/v1/webhooks/payments/:provider   (raw body)
 1. verify signature (constant-time compare)  → 401 on failure
 2. parse + validate payload (Zod)
 3. insert WebhookEvent (unique provider + eventId); duplicate → 200, no-op
 4. enqueue process-webhook job; return 200 immediately
worker: load event → dispatch by type → payments service → mark event PROCESSED / FAILED (with retries)
```

---

## 8. Asynchronous processing

### 8.1 Transactional outbox

Business code never enqueues a BullMQ job directly after a commit. That pattern loses messages on a crash, or announces work that was rolled back. Instead:

1. The service inserts an `OutboxEvent` row **inside** the business transaction.
2. An outbox relay job in the worker polls unpublished events, enqueues the BullMQ jobs and marks the events published.

Delivery is therefore at-least-once, so job handlers are idempotent (keyed by event ID).

### 8.2 Queues

| Queue | Jobs |
|---|---|
| `notifications` | `send-email`, `send-sms`, `send-notification` |
| `webhooks` | `process-webhook` |
| `maintenance` | `outbox-relay`, `expire-otp`, `reconcile-transactions`, `generate-statement` |

Jobs use bounded retries with exponential backoff. Jobs that keep failing stay in BullMQ's failed set so they can be inspected.

### 8.3 What lives in Redis vs PostgreSQL

| Data | Store | Why |
|---|---|---|
| Users, wallets, ledger, transactions, idempotency records, webhook events, audit | PostgreSQL | Must be durable and transactional |
| Rate-limit counters, OTPs (hashed, TTL), short-lived caches, in-progress locks, queues | Redis | Short-lived; losing them is safe |

Idempotency records live in **PostgreSQL**, written in the same transaction as the money movement. Redis is only used as an optional "request in progress" lock in front of them.

---

## 9. API conventions

- Base path `/api/v1`, JSON only, resource-oriented plural nouns.
- Success: `{ "data": ..., "meta": { ... } }`
- Error:
  ```json
  { "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "details": [...], "requestId": "..." } }
  ```
- Status codes: 200, 201, 202 (accepted async), 204, 400 (malformed), 401, 403, 404, 409 (conflict / state), 422 (validation / business rule), 429, 500.
- Pagination: cursor-based for transactions and ledger history (`?limit=&cursor=`); offset is acceptable for small admin lists.
- Filtering and sorting via whitelisted query params, validated by Zod.
- `Idempotency-Key` header required on money-moving `POST`s.
- Amounts as minor-unit strings with an explicit `currency`.
- IDs: UUIDs (v7, time-ordered), never sequential integers, to avoid enumeration.
- Documented with OpenAPI generated from the Zod schemas.

---

## 10. Security architecture

| Area | Design |
|---|---|
| Passwords | Argon2id |
| Access tokens | Short-lived JWT (about 15 min), with claims limited to user ID, session ID and roles |
| Refresh tokens | Opaque random values, stored **hashed**, rotated on every use, grouped into a family per session. Reuse of a rotated token revokes the whole family |
| Sessions / devices | Session row per login with device info, IP and user agent; users can list and revoke them |
| Authorization | RBAC: roles → permissions; routes declare required **permissions**, not roles |
| Resource ownership | Services verify the caller owns the wallet / transaction / beneficiary (prevents IDOR) |
| Input | Zod validation on every endpoint; unknown fields rejected |
| Transport / headers | Helmet, strict CORS allow-list, body size limits, `trust proxy` configured explicitly |
| Rate limiting | Redis-backed; strict on login, OTP, password reset and money movement |
| Webhooks | HMAC signature over the raw body, constant-time comparison, event-ID deduplication |
| OTPs | Random numeric, hashed in Redis, TTL, maximum attempts |
| Logging | Pino redaction paths for passwords, tokens, OTPs, authorization headers and identity numbers |
| Sensitive data | Identity numbers (BVN/NIN) encrypted at application level; KYC documents in private storage |
| Secrets | Environment variables validated at startup; `.env` never committed |
| Errors | Generic messages to clients; details only in logs, correlated by request ID |

---

## 11. Error handling

- `common/errors` defines `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `InsufficientFundsError`, `ForbiddenError`, …), each with a stable `code` and HTTP status.
- Services throw domain errors. The error middleware maps them to the error envelope.
- Unknown errors become `500 INTERNAL_ERROR`. The stack is logged, never returned.
- Prisma errors (unique violation, serialization failure) are translated at the service boundary.

---

## 12. Configuration and observability

- `config/env.ts` parses `process.env` with Zod at startup. The process refuses to start on missing or invalid config.
- Structured JSON logs (Pino) carry `requestId`, `userId` and module context.
- Health endpoints: `/health/live` (process up) and `/health/ready` (DB + Redis reachable).
- Graceful shutdown: stop accepting requests, drain in-flight requests, close workers, DB and Redis.

---

## 13. Testing strategy

| Level | Tooling | Focus |
|---|---|---|
| Unit | Vitest | Ledger invariants, fee/limit calculation, state transitions, token logic |
| Integration | Vitest + Testcontainers (real Postgres + Redis) | Services with a real DB: atomic postings, locking, idempotency, rollbacks |
| E2E | Supertest against the app | Full HTTP flows: register → KYC → fund → transfer → history |

Concurrency tests are required: fire N parallel transfers at one wallet and assert that no overdraft happens and that the ledger sums to zero.

---

## 14. Deployment

- Multi-stage Dockerfile; one image runs either the API (`server.js`) or the worker (`workers.js`).
- `docker-compose.yml` for local development: api, worker, postgres, redis.
- CI (GitHub Actions): install → lint → typecheck → unit → integration → build.
- Cloud target later (AWS): container hosting, managed PostgreSQL, managed Redis, S3 for KYC documents, centralized logs.

---

## 15. Open decisions

Defaults are proposed. Confirm or change them before the database design step.

| # | Decision | Proposed default |
|---|---|---|
| D1 | API amount format | Minor-unit integer **string** (`"1000000"` = ₦10,000) |
| D2 | Transfer recipient identifier | Unique user handle / wallet account number, not the internal user ID |
| D3 | Transaction limits | Tied to KYC tier (Tier 1/2/3) with daily and per-transaction limits |
| D4 | Admin accounts | Same `User` table with admin roles; admin endpoints require MFA later |
| D5 | Build order | Docker Compose, Redis, audit and the test harness set up early, not at the end |
| D6 | Fees | Fee entries posted in the same ledger transaction as the operation |

---

## 16. Planned additions to the folder structure

Added when the relevant module is built:

```text
src/modules/kyc/providers/          KycProvider interface + MockKycProvider
src/modules/payments/providers/     PaymentProvider interface + MockPaymentProvider
src/modules/payments/payment.schema.ts
src/common/idempotency/             idempotency service + middleware
src/common/outbox/                  outbox writer
src/jobs/jobs/                      outbox-relay, reconcile-transactions, expire-otp, ...
src/modules/health/                 liveness / readiness
```
