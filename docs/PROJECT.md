# Fundra — Project Definition

> What Fundra is, what it must do and what it deliberately will not do. This is the requirements baseline for every design and implementation decision. Written for the developer building Fundra and for reviewers assessing scope.
>
> **Source:** the original project brief (2026-10-01). **Status:** scope fixed; implementation not started. See [README](../README.md#status).

---

## 1. Purpose

Fundra is a **production-style fintech backend** that simulates the core infrastructure of a digital financial platform. Users can:

- register, verify their identity (KYC) and hold an NGN wallet
- fund the wallet, send money to other users, make payments and withdraw
- see a complete, explainable transaction history

The project exists to show backend engineering beyond CRUD: correctness under concurrency, double-entry accounting, idempotent money movement, provider integrations, webhooks, background processing, security and auditability.

It is a **portfolio and learning project** built by one developer, but it follows production-grade practices wherever reasonably possible.

---

## 2. Core principle: the ledger is the source of truth

Fundra never just changes a balance. Every movement of money creates **double-entry ledger entries** that explain where the money came from, where it went and why the balance changed.

```text
Total Debits = Total Credits     (for every transaction, and therefore for the whole system)
```

Wallet balances are a fast-read **projection** of the ledger, never the authority. Money operations are **atomic**: a transfer either completes entirely or not at all. The state "sender debited, recipient not credited" must be impossible.

---

## 3. User journey

```text
Register → Verify email/phone → Submit KYC → KYC approved → Wallet created
        → Fund wallet → Send / receive money → Make payments → Withdraw → View history
```

---

## 4. Functional requirements

### 4.1 Authentication
Registration, login, logout, JWT access tokens, refresh tokens with **rotation**, email verification, phone verification, password reset, session management, device tracking, and protections such as rate limiting and lockouts.

### 4.2 User management
Profiles, account status, contact information, profile updates, preferences, account deactivation.

### 4.3 KYC
KYC profile, identity information, document management, verification status, approval/rejection, admin review. Verification goes through a **`KycProvider` abstraction**. The first implementation is `MockKycProvider`; real providers are only used through a sandbox.

### 4.4 Wallets
A wallet has an ID, owner, currency, status, available balance, ledger balance and timestamps. **NGN only at first**, but the design must allow more currencies later. A wallet is created when KYC is approved.

### 4.5 Double-entry ledger
Supports debit, credit, transfer, deposit, withdrawal, payment, refund, reversal and fees. All postings are atomic and balanced.

### 4.6 Transactions
A central transaction record for every money operation.

| Types | Statuses |
|---|---|
| `DEPOSIT` `WITHDRAWAL` `TRANSFER` `PAYMENT` `REFUND` `FEE` `REVERSAL` | `PENDING` `PROCESSING` `COMPLETED` `FAILED` `REVERSED` `CANCELLED` |

Every transaction has a unique, human-readable reference, e.g. `FND-TRX-20261001-8F92A1`.

### 4.7 Peer-to-peer transfers
`POST /api/v1/transfers`. The backend must:
1. Authenticate the user and validate the request.
2. Check account status, KYC, wallet status, available balance, limits and idempotency.
3. Create the transaction and ledger entries, update balances and commit atomically.
4. Queue notifications.
5. Return the result.

### 4.8 Idempotency
Every money-moving operation (transfers, deposits, withdrawals, payments) accepts an `Idempotency-Key` header. Retrying with the same key must **never** create a second financial transaction.

### 4.9 Payments
Deposits, withdrawals and payments go through a **`PaymentProvider` abstraction**. The first implementation is `MockPaymentProvider`; Paystack or Flutterwave can be added later through their sandboxes.

### 4.10 Webhooks
`POST /api/v1/webhooks/payments`. Processing must be idempotent:

```text
receive → verify signature → validate payload → dedupe by event ID → persist
        → process → update transaction → update ledger → queue notification
```

### 4.11 Beneficiaries
Add, view, update and delete saved recipients, with appropriate security controls.

### 4.12 Notifications
Notifications are sent asynchronously for transfers (success and failure), deposits, withdrawals, logins, KYC changes, password changes and security events. Channels: email, SMS and push. Delivery runs through Redis + BullMQ background workers.

### 4.13 Background jobs
`send-email`, `send-sms`, `send-notification`, `process-webhook`, `generate-statement`, `expire-otp`, `reconcile-transactions`.

### 4.14 Admin
View and suspend users, review and approve/reject KYC, view and investigate transactions, view wallets, monitor activity, view audit logs and manage system settings. Uses **RBAC**, with permissions modelled separately from roles.

| Roles |
|---|
| `SUPER_ADMIN` `ADMIN` `SUPPORT` `COMPLIANCE` `FINANCE` `USER` |

### 4.15 Audit logging
Logins, password changes, KYC decisions, wallet suspensions, reversals, admin actions, beneficiary creation and financial transactions produce audit records:

```text
actor · action · resource · resourceId · IP address · user agent · timestamp · metadata
```

Audit records must not contain unnecessary sensitive data.

---

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Atomic DB transactions; balanced ledger; safe under concurrent requests; idempotent retries |
| Money | **Never** use JavaScript floating-point numbers as the authoritative representation of money |
| Security | Argon2id passwords, rotating refresh tokens, RBAC, validation, rate limiting, CORS, security headers, webhook signatures, audit logs, no secrets in logs |
| Logging | Structured JSON (Pino); passwords, tokens and OTPs never logged |
| API | Versioned REST at `/api/v1` with consistent methods, status codes, errors, pagination, filtering, sorting |
| Documentation | OpenAPI/Swagger, plus architecture, security, API, setup, testing and deployment docs |
| Quality | Strict TypeScript, ESLint, Prettier, automated tests (unit, integration, e2e) |
| Operability | Docker for local development and deployment; GitHub Actions CI; deployable to AWS later |

---

## 6. Technology constraints

Node.js (active LTS), TypeScript (strict), Express, PostgreSQL, Prisma, Zod, JWT, Argon2id, Redis, BullMQ, Pino, OpenAPI, Vitest, Supertest, Testcontainers, ESLint, Prettier, Docker, GitHub Actions.

**Rule:** before adding any dependency, check its current stable version against the official registry or docs. Exact installed versions are listed in the [README](../README.md#technology-stack).

---

## 7. Architecture constraints

- A **modular monolith** with one deployable codebase and clearly separated feature modules. No microservices.
- Modules: Auth, Users, KYC, Wallets, Ledger, Transactions, Transfers, Payments, Beneficiaries, Notifications, Webhooks, Audit, Admin.
- No unnecessary abstraction. Complexity must come from what the domain needs, not from a wish to look sophisticated.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

---

## 8. Out of scope

- Microservices or event sourcing
- Foreign exchange and multi-currency transactions (the design must still allow them later)
- Real money, real identity verification, or production provider credentials
- Frontend or mobile clients
- AWS services beyond what deployment strictly needs

---

## 9. Delivery approach

Build incrementally. For every major feature:

1. Explain its purpose and how it fits into Fundra.
2. Design the database entities.
3. Define the API contract.
4. Cover the security and financial considerations.
5. Implement it.
6. Test it.
7. Document how to run and verify it.

Build order from the brief:

```text
 1 Requirements      2 Architecture    3 Database/ERD    4 Ledger design   5 API spec
 6 Project init      7 Configuration   8 Auth            9 Users          10 KYC
11 Wallets          12 Ledger         13 Transactions   14 Transfers      15 Payments
16 Webhooks         17 Redis          18 Background jobs 19 Notifications 20 Beneficiaries
21 Admin            22 Audit logging  23 Testing        24 Docker         25 CI/CD
26 Deployment       27 Documentation
```

**Proposed change (decision D5 in [ARCHITECTURE.md](ARCHITECTURE.md#14-open-decisions)):** Redis (17), audit logging (22), testing (23) and Docker (24) are needed by earlier steps (idempotency, OTPs, KYC audit trails, Postgres for development). They should be set up as foundations during steps 6–7, and tests should be written alongside each module.

---

## 10. Definition of done

Fundra is complete when:

- Every module in §4 is implemented behind the versioned API, with OpenAPI documentation.
- Concurrency tests show that parallel transfers cannot overdraw a wallet or unbalance the ledger.
- Retried requests with the same idempotency key never duplicate money movement.
- Duplicate webhooks are processed exactly once.
- CI runs lint, type-check, unit, integration and build on every push.
- The stack runs locally with one `docker compose up`.
- The repository documents the architecture, financial model, API, security, setup, testing and deployment.
