# Fundra Performance

> What has been measured, how, and what it does and doesn't tell you; the indexes and why each exists; the likely bottlenecks; and what was deliberately not optimised. Written for whoever deploys or tunes Fundra. Everything here was measured or read from the code; nothing is estimated.

## The honest headline

**Fundra has not been deployed, and has not run on a real PostgreSQL server.** The numbers below come from the real application over real HTTP on a laptop, with the database being PGlite: PostgreSQL 18 compiled to WebAssembly, running inside the same Node process and serving every connection through **one** session. They are useful for relative costs, such as what a transfer costs next to a read, or what argon2 adds to a sign-in. They are **not** production latencies. Re-measure on real PostgreSQL and Redis (the Docker stack in the [README](../README.md)) before drawing capacity conclusions.

## Measurement

**When and where:** 2026-10-17, Intel Core i5-6300U (4 logical cores, 2.4 GHz, 2015), 8 GB RAM, Windows 11, Node 24.21.0. Database: PGlite 0.5.8 in process, all migrations, the real seed. Redis-side stores (rate limits, OTPs) in memory; payment provider: the mock.

**Method:** `app.listen()` on a local port and `fetch()` from the same process: real HTTP parsing, middleware, validation, Prisma and SQL, with no network hops. Before measuring: two verified customers, one funded, 30 transfers of history. Each endpoint: one **cold** call (the first), then N sequential **warm** calls reported as p50 / p95 / max. Sequential means no concurrency: these are single-request latencies, not throughput.

| Endpoint | Cold | Warm p50 | p95 | Max | N | Response |
|---|---|---|---|---|---|---|
| `GET /health/live` | 2.6 ms | 1.4 ms | 2.3 ms | 3.1 ms | 40 | 15 B |
| `GET /api/v1/openapi.json` | 3.1 ms | 3.3 ms | 13.5 ms | 14.2 ms | 40 | 72.7 KB |
| `POST /auth/login` | 71.9 ms | 65.6 ms | 114.6 ms | 114.6 ms | 15 | 801 B |
| `GET /users/me` | 21.6 ms | 13.1 ms | 35.4 ms | 44.1 ms | 40 | 385 B |
| `GET /wallets` | 53.7 ms | 18.9 ms | 44.2 ms | 55.6 ms | 40 | 239 B |
| `GET /transactions` (page of 20) | 40.1 ms | 29.5 ms | 100.4 ms | 143.6 ms | 40 | 8.5 KB |
| `POST /transfers` (new key) | 125.0 ms | 77.3 ms | 412.2 ms | 572.3 ms | 40 | 439 B |
| `POST /transfers` (idempotent replay) | 61.4 ms | 23.2 ms | 189.8 ms | 206.4 ms | 40 | 439 B |
| `POST /payments/deposits` | 84.6 ms | 61.7 ms | 94.7 ms | 94.7 ms | 20 | 475 B |

argon2id on its own (19 MiB, t=2, p=1): hash p50 **55 ms**, verify p50 **77 ms** (10 runs each).

**Reading it:**

- **Sign-in is argon2.** About 66 ms of a 66 ms login is the password check, by design: it is what makes stolen hashes slow to crack. It is also why sign-in has its own rate limit.
- **Authenticated reads cost ~13–30 ms here.** Every request reloads the session, user and roles (so suspensions and role changes apply at once), then does its own work. On PGlite every query waits its turn on one session, so this is an upper bound.
- **A transfer is the most expensive write**, at p50 77 ms. In one transaction it claims the idempotency key, locks two wallets in order, sums today's outflow, writes the transaction, transfer, two ledger entries, wallet balances, audit row and outbox event, and completes the key. Its **p95 of 412 ms is the number to re-check first** on real PostgreSQL: on PGlite, interactive transactions serialise on the single session.
- **A replay is about 3× cheaper** than a new transfer (23 ms against 77 ms): it reads the stored response and moves no money.
- **Deposits** include the provider call. The mock answers instantly, so a real provider's latency (typically hundreds of milliseconds) adds directly to this number, because the call is made inside the transaction (see [ARCHITECTURE §8.3](ARCHITECTURE.md#83-deposit-via-webhook--built-start--apply-the-webhook-endpoint-is-stage-15)).

## Not measured

| Gap | Why | How to close it |
|---|---|---|
| Throughput and contention (requests/second, a hot wallet under parallel transfers) | PGlite serves one session, so concurrency there measures PGlite | `autocannon` against the Docker stack; the Stage 11 parallel-debit test with Testcontainers |
| Queue latency (outbox → notification, webhook → ledger) on Redis | Redis isn't installed; on BullMQ's PostgreSQL backend over PGlite, workers poll instead of being woken | Run the worker against Redis and time `published_at` → notification `sent_at` |
| A real payment provider's latency | Only the mock exists | Sandbox provider |
| Memory under load, cold start of the container | Not deployed | Container metrics once deployed |

## Database indexes

The migrations create 50 indexes (unique ones included), plus each table's primary key. The ones that carry the hot paths:

| Index | Serves |
|---|---|
| `transactions (source_wallet_id, created_at DESC, id DESC)` and the same on `destination_wallet_id` | History: keyset pagination on (created_at, id) for both sides of a wallet; today's outflow sum for the daily limit |
| `transactions (status, created_at) WHERE status IN ('PENDING','PROCESSING')` | Reconciliation's "in flight over a day" and any sweep of open transactions, without scanning finished ones |
| `ledger_entries (ledger_account_id, created_at, id)` | Statements (entries of an account in a period, in order; the opening balance is the last one before), reconciliation's per-account sums |
| `ledger_entries (transaction_id)` | "Does this transaction have entries" (state-machine checks), transaction detail |
| `holds (wallet_id) WHERE status = 'ACTIVE'` | Available balance checks and reconciliation, ignoring settled and released holds |
| `idempotency_keys (user_id, key)` unique | The claim itself: one row per key, the lock |
| `idempotency_keys (expires_at)` | The hourly purge of expired keys |
| `webhook_events (provider_id, event_id)` unique | Deduplication of provider deliveries |
| `payments (provider_id, provider_reference)` unique | Matching a webhook to its payment |
| `outbox_events (created_at) WHERE published_at IS NULL` | The relay's batch: oldest unpublished first, without touching the published history |
| `sessions (user_id) WHERE revoked_at IS NULL` | Active devices, and ending them all on a password change |
| `notifications (user_id, created_at DESC)` | The in-app feed |
| `audit_logs (resource_type, resource_id, created_at)`, `(actor_user_id, created_at)`, `(action, created_at)` | The admin audit filters |
| `fee_rules (transaction_type, currency) WHERE is_active` unique | One active fee rule, read on every money movement |

Partial indexes are used wherever a query only ever looks at a small live subset (open transactions, active holds, unpublished events, live sessions), so the index stays small as history grows.

## Likely bottlenecks, ranked

1. **Lock contention on a hot wallet.** Every movement locks its wallets in ID order, so one very busy wallet (a merchant, a fee account) serialises its transfers. That is the price of provably correct balances; sharded sub-wallets would be the fix if it ever shows up. Not measurable on PGlite.
2. **The per-request session check.** Three lookups (session, user, roles) on every authenticated call, chosen so a revoked role or suspension applies immediately. A short-lived cache would cut it at the cost of that immediacy.
3. **Provider calls inside the deposit transaction.** A slow provider holds a pooled connection (no locks) for its latency. Real adapters need a short timeout.
4. **Statement generation** reads a period's entries into memory and builds the CSV in one string, which is fine for a year of personal activity. A business account would want streaming.
5. **Reconciliation** sums every wallet's entries in one snapshot, hourly. That is linear in ledger size; at scale it would check incrementally from a last-reconciled point.

## Deliberately not optimised

- **No response compression in the app.** Nothing compresses responses: `openapi.json` goes out at 72.7 KB and a history page at 8.5 KB uncompressed. This is left to the reverse proxy or load balancer, which does it better, but **someone must turn it on at deployment**.
- **No read cache.** Balances, limits and fee rules are read from PostgreSQL every time, so an admin's change applies to the very next transaction. A cache would add a class of staleness bugs to the part of the system where correctness matters most.
- **No connection-level read replicas.** One database is the source of truth; history and statements could move to a replica if reads ever dominate.
- **argon2 is not tuned down** for speed; its cost is the point.
- **Prisma's overlapping in-transaction queries** (a deprecation warning from `pg`, seen again during these measurements) aren't worked around. Fundra's own code is sequential, and the rest waits on Prisma ([ARCHITECTURE §13](ARCHITECTURE.md#13-known-debt-and-current-gaps)).
