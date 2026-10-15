# Fundra Security

The security design overview is in [ARCHITECTURE.md §11](ARCHITECTURE.md#11-security-architecture--designed). Detailed controls (token lifecycle, password policy, rate limits, webhook verification, data protection) are documented here as each module is built.

## Payment webhooks

`POST /api/v1/webhooks/payments` is the one route that takes no user credentials, so the signature carries the whole trust decision ([ARCHITECTURE.md §8.6](ARCHITECTURE.md#86-webhooks--built-receive-and-persist-processing-is-item-2)).

- **Exact bytes.** The router reads the body raw, before JSON parsing, and verifies the HMAC over those bytes. A parser that normalised the JSON would make genuine webhooks fail, or tempt someone to verify a re-serialised copy.
- **Constant time.** The signature is compared with `timingSafeEqual`, after checking it is 128 hex characters, so its validity can't be discovered byte by byte.
- **Nothing unverified is kept.** A bad signature is answered `401` before the payload is parsed or stored.
- **Replays are no-ops.** The unique `(provider_id, event_id)` index stores each event once; a replay gets `200 DUPLICATE`. Replaying an old signed event can't move money twice: processing is idempotent too (row locks, re-checked state).
- **The secret** is `PAYMENT_WEBHOOK_SECRET` (≥ 32 characters, env only, never logged or stored). Rotating it needs a short overlap window with the provider; that's a Stage 25 item.
- **Size.** Bodies over 64 KB are refused before verification.
