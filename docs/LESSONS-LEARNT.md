# Fundra — Lessons Learnt

> Real mistakes and surprises from building Fundra, each with its symptom, root cause, fix and the principle worth keeping. Written for anyone working on this codebase, or on money software like it. Most were caught before they shipped. One wasn't, and that one is here too.

## 1. A failing test was committed and pushed

**What happened.** A commit went to `main` while one test was failing. Every later run passed, so for a while it looked like nothing had happened.

**Root cause.** The commit gate was a shell chain: `vitest run | grep "Tests " && git commit && git push`. The chain checked the exit code of `grep`, which succeeds whenever it finds the summary line, including `Tests 1 failed | 591 passed`. The failure itself was a timing-sensitive test that only fails when the CPU is saturated. That's why it was hard to notice: the next eight runs were green.

**Fix.** Gates now capture the test runner's own exit code (`vitest run; rc=$?`) and commit only on `rc == 0`. The flaky tests were identified by loading the machine on purpose (`password.test.ts` compares hash timings; `shutdown.test.ts` has a 5 s budget).

**Principle.** *A gate is only as strict as the exit code it reads.* Pipe through filters for display, never for decisions.

## 2. Blaming the test database instead of the test

**What happened.** A check failed with "wallet does not exist". I attributed it to PGlite, which has real quirks, and added a workaround. The actual cause was a script bug: `fund(ada)` passed the user where the helper needed the user's wallet. Later, a "Server has closed the connection" error was first blamed on PGlite closing connections after failed statements. It was really the socket server's default connection limit, which was lower than the pool size.

**Root cause.** Once an environment has known quirks, every failure starts to look like one of them. Both explanations were plausible, and neither was verified.

**Fix.** The workaround was reverted and the helper fixed. For the connection error, a minimal probe compared one variable at a time: the pool size (failed) against the server's `maxConnections` (fixed). The wrong comment was corrected in the code.

**Principle.** *A known quirk is a hypothesis, not an explanation.* Reproduce it in a minimal probe before writing a workaround for it.

## 3. A wrong relation name passed the type checker

**What happened.** The admin transaction detail endpoint answered `500`. The code asked Prisma for `include: { reversal: … }`; the relation is called `reversedBy`.

**Root cause.** The include object was built by spreading a shared constant (`{ ...TX_INCLUDE, reversal: … }`), and in that shape TypeScript's excess-property check didn't flag the unknown key. `tsc` was clean, ESLint was clean, and the unit tests used a stand-in database.

**Fix.** Renamed; the endpoint is covered by a check against real PostgreSQL and by the operations e2e suite.

**Principle.** *Types prove shapes, not that the database agrees.* A query has to run against the real schema at least once before it's done.

## 4. Deliberate code breaks that silently didn't apply

**What happened.** Several times, a "break the code and see the test fail" step reported a result for a break that never happened. A `sed` pattern no longer matched because Prettier had re-wrapped the line, so the code ran unbroken, and "caught" or "not caught" meant nothing.

**Root cause.** The break and the run were one command. Nothing checked that the edit had landed.

**Fix.** Every break now prints how many places it changed (`grep -c` after `sed`) and restores from a backup it then verifies (`cmp`). A count of 0 means the result is void. This caught several no-op breaks that would have been reported as passes.

**Principle.** *Verify the experiment, not just its outcome.* An unapplied change produces a convincing, meaningless result.

## 5. The ORM issues overlapping queries on one transaction

**What happened.** `pg` printed *"Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9"* during transfers.

**Root cause.** Two sources. Fundra's own `Promise.all` inside interactive transactions (fixed: those calls are now sequential). And **Prisma 7.10's query engine itself**, which overlaps queries when loading `include`d relations. `--trace-deprecation` showed the stack inside Prisma.

**Fix.** Fundra's side was fixed. Prisma's side is recorded as debt with a concrete consequence: **don't upgrade `pg` to 9** until Prisma serialises in-transaction queries.

**Principle.** *Read deprecation warnings to the bottom of the stack.* The part you can't fix becomes a pinned constraint with a reason, not a silenced warning.

## 6. jsonb reorders keys, so a byte-equal replay check failed

**What happened.** An idempotent replay returned the same data as the original response, but a byte comparison said they differed.

**Root cause.** The stored response lives in a `jsonb` column, and PostgreSQL normalises `jsonb` key order. The replay is semantically identical, but not byte-identical.

**Fix.** Checks compare canonical JSON (sorted keys). The behaviour is documented in the API reference, so clients don't compare raw bytes either.

**Principle.** *Know what your storage type promises.* `jsonb` keeps meaning, not text. If byte-for-byte replay mattered, the column would have to be `text`.

## 7. Webhook signatures can't survive a JSON parser

**What happened.** No incident: this was designed for up front, and a deliberate break proved it mattered. Re-serialising the body before verification (what a global `express.json()` does) made the re-formatted-delivery check fail at once.

**Root cause.** An HMAC covers bytes. Parsing and re-serialising produces different bytes for the same meaning (whitespace, key order, number formats).

**Fix.** The webhook router is mounted **before** JSON parsing and reads the raw body.

**Principle.** *Verify signatures over exactly what was signed.* Middleware order is part of the security design.

## 8. "Pay out, then record" is the wrong order

**What happened.** The first withdrawal design sent the payout inside the database transaction, as deposits do. That meant a crash or failed COMMIT after the provider accepted would leave money paid out with no record of it.

**Root cause.** Deposits and payouts look symmetrical but aren't. A deposit session that's never committed is harmless, because its checkout link never reached anyone. A payout that's never committed is lost money.

**Fix.** Withdrawals and bill payments reserve (hold), **commit**, then dispatch. Dispatch is idempotent (the provider dedupes our reference), so a crash is retried safely. Webhook matching also falls back to our own reference, for when the provider answers before the dispatch has recorded its reference.

**Principle.** *Record intent before an irreversible external effect, never after.* Then make the effect idempotent, so retrying the gap is safe.

## 9. Test infrastructure has limits; don't let them leak into the code

**What happened.** On PGlite, simultaneous identical webhooks returned `null` from an `INSERT`. BullMQ workers picked jobs up seconds late. A test client's queries interleaved with the worker's (`bind message supplies 3 parameters, but … requires 6`). Each one looked like an application bug.

**Root cause.** PGlite serves every connection through one session, doesn't relay `LISTEN/NOTIFY`, and mis-routes responses when concurrent statements fail. Small probes proved each one in isolation.

**Fix.** The fixes went into the tests, not the app: sequential "at once" checks on PGlite, BullMQ on its own PGlite server, and a single-connection pool where the checks poll while a worker runs. Each limit is documented, and the real concurrency tests wait for real PostgreSQL. The application code wasn't changed to suit the test database.

**Principle.** *When the test environment is the problem, change the test, document why, and keep the real check on the list.* Bending production code around a test double hides real bugs later.

## 10. Rate limits made an unrelated step fail

**What happened.** An e2e test failed at "find the wallet after KYC" with *record not found*.

**Root cause.** All the test's users sign up from one IP, and each sign-up makes four one-time-code calls against a limit of 10 per 15 minutes per IP. By the third user, verification was being rate-limited, so KYC refused the unverified account, so no wallet existed. The helper ignored the failed responses, so the error surfaced two steps later.

**Fix.** The e2e harness uses a store that never throttles (rate limits have their own unit tests), and the sign-up helper now **throws at the step that failed**, with the response body.

**Principle.** *Fail at the first wrong thing.* A helper that ignores an unexpected status turns one clear error into a mystery somewhere else.

## Summary

| # | Lesson | Principle |
|---|---|---|
| 1 | A failing test reached `main` through a `grep` gate | Gate on the runner's exit code |
| 2 | Test-database quirks blamed for script bugs | A known quirk is a hypothesis: probe it |
| 3 | Wrong Prisma relation name passed `tsc` | Run every query against the real schema once |
| 4 | Code breaks that didn't apply | Verify the experiment, not just its outcome |
| 5 | ORM overlapped queries in a transaction | Follow deprecations to the bottom; pin what you can't fix |
| 6 | `jsonb` reordered a replayed body | Know what your storage type promises |
| 7 | Signatures vs JSON parsing | Verify over the exact signed bytes |
| 8 | Payout before COMMIT | Record intent before irreversible effects; make them idempotent |
| 9 | PGlite limits looked like app bugs | Fix the test, document it, keep the real check |
| 10 | Rate limits broke an unrelated step | Fail at the first wrong thing |

## Is the unpaid trade-off still paying off?

The largest trade-off is that **nothing has run on real PostgreSQL or Redis servers.** There are no Docker-based integration tests, and real concurrency hasn't been tested. In its place:
- every item was checked against PostgreSQL 18 in process (PGlite), with deliberate code breaks;
- the scenarios that matter run in the repo as e2e tests;
- the image is built and started in CI.

So far it has paid off. It made correctness work possible without Docker, and it found real bugs (#3 above among them) that unit tests with a stand-in database had passed. But lessons #2 and #9 show its cost. A meaningful share of debugging time went into PGlite rather than Fundra, and the most important property of a money system (correct behaviour under real concurrency) is exactly what this environment can't show. The locks, constraints and triggers are in place and individually verified, but until the Testcontainers suite runs, "concurrency-safe" is a design claim, not a measured result.
