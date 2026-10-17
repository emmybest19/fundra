# Fundra Security

> How Fundra protects accounts, money and personal data, and what it does not protect against yet. Written for reviewers and for developers changing anything security-relevant. The design overview is [ARCHITECTURE.md §11](ARCHITECTURE.md#11-security-architecture--designed); every control here points at the code or the test that enforces it.

## Threat model in one table

| Threat | Main controls |
|---|---|
| Stolen or guessed passwords | argon2id, lockout after 5 failures, rate limits, timing-equal "unknown account" path |
| Stolen tokens | 15-minute access tokens; refresh tokens rotated, stored hashed, reuse ends the session; sign-out per device |
| Account takeover via a session | Sensitive actions re-check the password; alerts to the *old* email or phone on contact changes; new-device sign-in alerts |
| Paying twice / lost money | Idempotency keys in the money transaction, row locks, append-only double-entry ledger, holds, reconciliation |
| Forged or replayed provider callbacks | HMAC over the raw body, constant-time compare, event-ID dedupe, idempotent processing |
| Insiders | Least-privilege roles with every route × role tested, no self-action, separation of duties, audit trail that can't be edited |
| The application itself going wrong | The database refuses unbalanced or edited ledger rows, and the app's role can't switch those guards off |
| Personal data leaking | BVN/NIN encrypted, masked identifiers, logs and audit redacted, no PII in event payloads |

## Authentication

| Control | Detail | Where |
|---|---|---|
| Password hashing | **argon2id**, 19 MiB memory, 2 iterations, parallelism 1 (OWASP's minimum profile); hashes upgraded on sign-in when the parameters change | [password.ts](../src/modules/auth/password.ts) |
| Password policy | 10–128 characters, and must not contain the person's handle or the name part of their email (3+ characters) | [password.ts](../src/modules/auth/password.ts), the services |
| Unknown accounts | A dummy hash is verified, so "no such account" takes as long as "wrong password"; both answer `INVALID_CREDENTIALS` | [auth.service.ts](../src/modules/auth/auth.service.ts) |
| Lockout | 5 consecutive failures lock the account for 15 minutes. During a lock the password isn't even checked, so guessing learns nothing. Re-authentication for sensitive actions shares the counter | `MAX_FAILED_LOGINS`, `LOCKOUT_MS` |
| Access tokens | JWT, **HS256 only** (`alg: none` and algorithm swaps refused), 15 minutes, signed with `JWT_ACCESS_SECRET` (≥ 32 characters). Every request also checks the session is live and the account active | [tokens.ts](../src/modules/auth/tokens.ts), [auth.middleware.ts](../src/middleware/auth.middleware.ts) |
| Refresh tokens | Opaque, stored only as SHA-256, rotated on every use within a 30-day session. Presenting an already-used token **ends the whole session** (`REFRESH_TOKEN_REUSED`): whoever holds the stolen copy is signed out too | [auth.service.ts](../src/modules/auth/auth.service.ts) |
| Sessions | Listed per device; any one, or all others, can be ended. Password changes and resets end every session | `/auth/sessions` |
| One-time codes | 6 digits from a CSPRNG, stored in Redis only as an HMAC (`OTP_SECRET`) bound to purpose and user, 10-minute TTL, 5 attempts then destroyed, single use, 60 s resend cooldown. Counting happens in one Lua script, so parallel guesses can't share attempts. Codes are never logged or stored in the database, or passed through job queues | [otp.ts](../src/modules/auth/otp.ts) |
| Verification | Money movement needs a verified email **and** phone (`ACCOUNT_NOT_ACTIVE` otherwise) | `requireActiveAccount` |

Tested by unit tests and `tests/e2e/account-security.test.ts`: rotation and reuse, devices, lockout, reset, password change, contact change, deactivation.

## Authorization

- **Customers** act only on what they own, enforced in the query itself (`WHERE user_id = caller`). Someone else's transaction, beneficiary, statement or notification is a plain `404`, never a `403` that would confirm it exists.
- **Staff** use role-based permissions ([rbac.ts](../src/common/constants/rbac.ts)): SUPPORT reads, COMPLIANCE decides KYC and freezes, FINANCE reverses money, SUPER_ADMIN assigns roles. Every admin route is declared once with its permission, and the router is built from that table. **Every route × every role** is tested through the real router ([permission-matrix.test.ts](../tests/unit/admin/permission-matrix.test.ts), 176 cases), and a pinned table makes any change to a guard deliberate.
- **Separation of duties:** no role but SUPER_ADMIN can both decide KYC and reverse money (tested). Nobody reviews their own KYC, reverses a transfer touching their own wallet, freezes their own wallet, suspends themselves or changes their own roles. Only a super admin can suspend a staff account, and the last super admin can't be removed.
- **Immediate effect:** roles and account status are read from the database on every request, so a revoked role or a suspension applies to the very next call with the same token.

## Money integrity

| Control | What it stops |
|---|---|
| Double-entry ledger; one posting per transaction | Money created or lost by a partial write |
| Deferred trigger: Σ debits = Σ credits at COMMIT (`FN002`) | An unbalanced posting reaching the database |
| Append-only triggers on entries, ledger accounts, audit log (`FN001`) | History being edited or deleted, even by the app |
| `CHECK` constraints (non-negative balances, currency matches, status rules) | Impossible states |
| Idempotency key claimed and completed **in the money transaction**, with fencing | Double charges on retries, timeouts and stale takeovers |
| Wallet row locks in ascending ID order; limits checked under the lock | Races, deadlocks, two parallel sends jointly beating a limit |
| Holds (available = ledger − holds) | Spending money that is on its way out |
| Payouts sent only **after** COMMIT; provider deduplicates our reference | Paying out money with no record, or paying twice after a timeout |
| Suspicious provider events held for review, never auto-applied | Wrong amounts, late or contradictory news crediting money |
| Hourly reconciliation (cache vs entries, invariants) that reports, never corrects | Silent drift |
| `fundra_app` database role: owns nothing, insert-only on append-only tables | The app, a bug or an injection disabling the triggers (`ALTER … DISABLE TRIGGER` needs the owner). Tested in `tests/e2e/app-role.test.ts` ([DATABASE.md §9.1](DATABASE.md#91-database-roles)) |

## Payment webhooks

`POST /api/v1/webhooks/payments` is the one route that takes no user credentials, so the signature carries the whole trust decision ([ARCHITECTURE.md §8.6](ARCHITECTURE.md#86-webhooks--built)).

- **Exact bytes.** The router reads the body raw, before JSON parsing, and verifies the HMAC over those bytes. A parser that normalised the JSON would make genuine webhooks fail, or tempt someone to verify a re-serialised copy.
- **Constant time.** The signature is compared with `timingSafeEqual`, after checking it is 128 hex characters, so its validity can't be discovered byte by byte.
- **Nothing unverified is kept.** A bad signature is answered `401` before the payload is parsed or stored.
- **Replays are no-ops.** The unique `(provider_id, event_id)` index stores each event once; a replay gets `200 DUPLICATE`. Replaying an old signed event can't move money twice: processing is idempotent too (row locks, re-checked state).
- **The secret** is `PAYMENT_WEBHOOK_SECRET` (≥ 32 characters, env only, never logged or stored). Rotating it needs a short overlap window with the provider.
- **Size.** Bodies over 64 KB are refused before verification.

## Personal data

- **BVN and NIN** are encrypted with AES-256-GCM (`KYC_ENCRYPTION_KEY`); uniqueness is checked with an HMAC under a separate key (`KYC_HMAC_KEY`), so the database never holds them in the clear and lookups never decrypt. Providers return a verdict, never their record of the person, so Fundra doesn't keep it.
- **KYC documents:** at most 5 MB; the declared type must match the file's own bytes (PNG, JPEG, PDF), so a renamed script is refused; stored outside the web root under generated keys, never served directly.
- **Masking:** bank account numbers are masked (`******6789`) in responses about other parties, audit records and notifications; recipients are shown by name and handle only.
- **Logs and audit:** values under sensitive keys (passwords, tokens, OTPs, PINs, BVN/NIN, `authorization`, cookies…) are replaced with `[REDACTED]` at any depth ([sensitive-keys.ts](../src/common/constants/sensitive-keys.ts)). Event payloads carry IDs, not names or contact details. Freeze reasons stay in the audit log and are never shown to the customer (no tipping off).
- **Statements:** CSV cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`, so user-written descriptions can't run as spreadsheet formulas.

## HTTP hardening

- `helmet` defaults: a strict Content-Security-Policy (`script-src 'self'`; Swagger UI is served from the installed package with our own initializer, so the CSP isn't loosened), `nosniff`, frame denial, HSTS.
- CORS: no browser origin is allowed until listed in `CORS_ORIGINS`; `TRUST_PROXY_HOPS` is 0 unless set, so clients can't spoof their IP with `X-Forwarded-For`.
- JSON bodies are capped at 100 KB and parsed strictly. Every input is validated with strict Zod schemas, which refuse unknown fields such as a client-chosen fee, account name or user ID.
- Rate limits per IP and per user ([api.md](api.md#rate-limits)); money endpoints and lookups that could enumerate people have their own.
- Errors: clients get a stable `code` and a safe message. 5xx details stay in the logs, joined to the response by `requestId`.
- Responses about money or people are `Cache-Control: no-store`.

## Supply chain

- New dependencies (and GitHub Actions) are used only at versions at least two weeks old, checked against the registry.
- `package.json` `allowScripts` lists the only packages allowed to run install scripts (argon2, Prisma); others are blocked, including `@scarf/scarf`'s telemetry.
- GitHub Actions are pinned to commit SHAs; the workflow has read-only permissions.
- The Docker image runs as a non-root user, has no dev dependencies or source maps, and takes secrets only from the environment.

## Known gaps

| Gap | Note |
|---|---|
| Real concurrency hasn't been tested on a real PostgreSQL server | The locks and constraints are in place; the parallel tests wait for Docker (Testcontainers) |
| Email, SMS and push are mocks | Real providers arrive with deployment |
| Secret rotation (JWT, OTP, KYC keys, webhook secret) has no tooling | Rotating a key today means a planned change; key IDs and overlap windows are future work |
| No MFA for staff | Staff accounts rely on password + verified email/phone; TOTP for admins would be the next step |
| A compromised database owner or superuser can do anything | The app role limits the application, not the DBA |
