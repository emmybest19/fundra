# Fundra API

> The HTTP contract: base path, response envelopes and error codes. Endpoint contracts are added per module as they are built. Written for API consumers and for developers adding endpoints.

Base path: `/api/v1`. All bodies are JSON. Further conventions (pagination, idempotency, amounts) are in [ARCHITECTURE.md §12](ARCHITECTURE.md#12-cross-cutting-conventions--designed).

---

## Response envelopes

**Success:** `data` holds the result. `meta` appears only on lists and other annotated results.

```json
{ "data": { "id": "..." } }
{ "data": [ ... ], "meta": { "nextCursor": "..." } }
```

**Error:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields.",
    "details": [
      { "path": "body.amount", "message": "Must be a positive whole number of kobo as a string, e.g. \"1000000\" for ₦10,000.00" },
      { "path": "query.limit", "message": "Too small: expected number to be >=1" }
    ],
    "requestId": "8f0c..."
  }
}
```

| Field | Present | Meaning |
|---|---|---|
| `code` | always | Stable, machine-readable. **Branch on this, not on `message`.** |
| `message` | always | Human-readable. For 5xx it is always the generic `An unexpected error occurred.` |
| `details` | validation errors | One entry per problem, all locations reported together. `path` starts with where the problem is (`params`, `query` or `body`), then the dotted field path, e.g. `body.recipient.handle`. A bare `body` means the body itself is missing or not a JSON object. Submitted values are never echoed back |

### Input rules

| Rule | Behaviour |
|---|---|
| Unknown fields | Rejected (`422`), not silently ignored |
| Amounts | Strings of kobo: `"1000000"` = ₦10,000.00. Positive, digits only, no leading zeros, at most 15 digits. JSON numbers are rejected because they can lose precision |
| Currency | `NGN` (upper case) |
| Repeated query parameters | `?limit=10&limit=100` is rejected rather than silently picking one |
| Pagination | `limit` 1–100 (default 20), optional opaque `cursor` |
| `requestId` | when available | Quote it when reporting a problem; it links to the server logs |

Implementation: [src/common/errors/](../src/common/errors/) and [src/common/utils/response.ts](../src/common/utils/response.ts).

---

## Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed request, e.g. invalid JSON |
| 401 | `UNAUTHENTICATED` | Missing, invalid or expired credentials |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Resource doesn't exist or isn't visible to the caller |
| 409 | `CONFLICT` | Conflicts with current state (duplicate, wrong status) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | `Idempotency-Key` header missing or malformed (see [Idempotency](#idempotency)) |
| 409 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | A request with the same key is still being processed |
| 413 | `PAYLOAD_TOO_LARGE` | Request body exceeds the size limit |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Key already used for a different request |
| 401 | `INVALID_CREDENTIALS` | Email/phone or password incorrect (deliberately doesn't say which) |
| 403 | `ACCOUNT_LOCKED` | Too many failed sign-ins; locked for 15 minutes |
| 403 | `ACCOUNT_DISABLED` | Account suspended or deactivated (only shown after a correct password) |
| 409 | `HANDLE_TAKEN` | Handle already in use |
| 409 | `ACCOUNT_EXISTS` | Email or phone already registered (deliberately doesn't say which) |
| 401 | `ACCESS_TOKEN_EXPIRED` | Access token expired; refresh and retry (see [Authenticated requests](#authenticated-requests)) |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token unknown, expired, or its session ended |
| 401 | `REFRESH_TOKEN_REUSED` | An already-used refresh token was presented; the session was ended as a precaution |
| 422 | `VALIDATION_ERROR` | Well-formed request with invalid fields; see `details` |
| 422 | `UNPROCESSABLE` | Valid request that breaks a business rule. Modules use more specific codes (e.g. `INSUFFICIENT_FUNDS`) as they are added |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server failure; details are only in the logs |
| 503 | `SERVICE_UNAVAILABLE` | A dependency (database, Redis) is unavailable |

Module-specific codes are registered in [error-codes.ts](../src/common/errors/error-codes.ts) and listed here as each module is built.

---

## Idempotency

Every money-moving `POST` (transfers, deposits, withdrawals, payments) **requires** an `Idempotency-Key` header. Generate a new UUID per *intended* operation and reuse it only to retry that same operation.

```http
POST /api/v1/transfers
Idempotency-Key: 3f6c2b1e-9a7d-4c1e-8f2a-5b6c7d8e9f00
```

| Situation | Response |
|---|---|
| First request with this key | Executes normally |
| Retry after the first one completed (any time within 24 h) | The **original status and body are replayed** with header `Idempotent-Replayed: true`. Nothing executes again. The replayed JSON has the same values; key order may differ |
| Retry while the first is still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. Retry shortly |
| Same key, different body, amount, recipient or endpoint | `422 IDEMPOTENCY_KEY_REUSED`. Use a new key |
| The first request failed (error response) | Nothing was executed; retrying with the same key runs it again |
| Header missing | `400 IDEMPOTENCY_KEY_REQUIRED` |
| Header malformed (must be 8–255 visible ASCII characters) | `400 IDEMPOTENCY_KEY_INVALID` |
| Key older than 24 h | Treated as new |

Keys are scoped per user, so two users can never collide. Body key order doesn't matter: `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same request.

---

## Endpoints

### Auth

#### `POST /api/v1/auth/register`

Creates a customer account. Public. Rate limit: 10 per hour per IP, plus the global limit.

```json
{
  "email": "emma@fundra.dev",
  "phone": "08012345678",
  "handle": "emma_o",
  "firstName": "Emma",
  "lastName": "Okafor",
  "password": "purple elephant 42"
}
```

| Field | Rules |
|---|---|
| `email` | Valid email, ≤254 chars; stored lower-case |
| `phone` | E.164 (`+2348012345678`) or Nigerian local (`08012345678`); spaces, dashes and brackets ignored; stored as E.164 |
| `handle` | 3–20 of `a-z 0-9 _`; a leading `@` is dropped; stored lower-case; public |
| `firstName`, `lastName` | 1–100 chars, trimmed |
| `password` | 10–128 chars; must not contain your handle or email name. No symbol/digit rules (NIST SP 800-63B) |

**201 Created**

```json
{
  "data": {
    "user": {
      "id": "01a0…", "email": "emma@fundra.dev", "emailVerified": false,
      "phone": "+2348012345678", "phoneVerified": false, "handle": "emma_o",
      "firstName": "Emma", "lastName": "Okafor", "status": "PENDING_VERIFICATION",
      "createdAt": "2026-10-03T09:00:00.000Z"
    }
  }
}
```

Errors: `422 VALIDATION_ERROR`, `409 HANDLE_TAKEN`, `409 ACCOUNT_EXISTS`, `429 RATE_LIMITED`. No tokens are issued here; sign in with `/login`.

#### `POST /api/v1/auth/login`

Public. Rate limit: 20 per 15 minutes per IP; additionally 5 wrong passwords lock the account for 15 minutes.

```json
{ "identifier": "emma@fundra.dev", "password": "purple elephant 42", "deviceId": "a1b2c3", "deviceName": "Emma's Pixel" }
```

`identifier` is the email or the phone (any accepted format). `deviceId` (≤128) and `deviceName` (≤100) are optional and label the session.

**200 OK** (`Cache-Control: no-store`)

```json
{
  "data": {
    "tokenType": "Bearer",
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "accessTokenExpiresAt": "2026-10-03T09:15:00.000Z",
    "refreshToken": "fnd_rt_3q2-…",
    "refreshTokenExpiresAt": "2026-11-02T09:00:00.000Z",
    "user": { "id": "01a0…", "handle": "emma_o", "status": "PENDING_VERIFICATION", "…": "…" }
  }
}
```

Errors: `401 INVALID_CREDENTIALS` (unknown account *or* wrong password), `403 ACCOUNT_LOCKED`, `403 ACCOUNT_DISABLED`, `422`, `429`. Accounts still `PENDING_VERIFICATION` can sign in (to verify their email and phone).

#### `POST /api/v1/auth/refresh`

Exchanges a refresh token for a new access token **and a new refresh token**. The old refresh token stops working immediately. Rate limit: 60 per 15 minutes per IP.

```json
{ "refreshToken": "fnd_rt_3q2-…" }
```

**200 OK**: same token fields as login, without `user`. The session's expiry (`refreshTokenExpiresAt`) does not move.

| Error | Meaning |
|---|---|
| `401 INVALID_REFRESH_TOKEN` | Unknown, expired, or its session was ended. Sign in again |
| `401 REFRESH_TOKEN_REUSED` | This token was **already used**. Fundra treats that as theft and ends the session; sign in again |
| `403 ACCOUNT_DISABLED` | The account was suspended; the session is ended |

**Clients must not refresh in parallel.** Send one refresh at a time and store the new refresh token before using it. Two concurrent refreshes with the same token look exactly like a stolen token being replayed, and end the session.

#### `POST /api/v1/auth/logout`

Ends the session that owns the refresh token. **Always `204 No Content`**, even for unknown or already-ended sessions, so the endpoint can't be used to test tokens.

```json
{ "refreshToken": "fnd_rt_3q2-…" }
```

The access token stops working immediately as well: every authenticated request checks that its session is still active.

### Authenticated requests

Send the access token on every protected endpoint:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs…
```

| Response | Meaning | Client action |
|---|---|---|
| `401 ACCESS_TOKEN_EXPIRED` | The access token is older than 15 minutes | Call `/auth/refresh`, retry once |
| `401 UNAUTHENTICATED` | Missing or invalid token, or the session ended (logout, remote sign-out, password change) | Sign in again |
| `403 ACCOUNT_DISABLED` | The account is suspended or deactivated | Show a support message |

Every 401 includes `WWW-Authenticate: Bearer realm="fundra"`.

### Sessions (signed-in devices)

All require authentication. A session is one sign-in on one device.

#### `GET /api/v1/auth/sessions`

**200 OK**: your active sessions, most recently used first.

```json
{
  "data": [
    {
      "id": "01a0…", "current": true,
      "deviceId": "laptop-1", "deviceName": "Work laptop",
      "userAgent": "Mozilla/5.0 …", "ipAddress": "203.0.113.7",
      "createdAt": "2026-10-03T09:00:00.000Z", "lastUsedAt": "2026-10-03T09:42:10.000Z",
      "expiresAt": "2026-11-02T09:00:00.000Z"
    }
  ]
}
```

#### `DELETE /api/v1/auth/sessions/:id`

Signs that device out: its access and refresh tokens stop working immediately. **204**, or **404** if the session isn't yours or has already ended (other users' sessions are never revealed). Revoking your own current session is equivalent to logout.

#### `DELETE /api/v1/auth/sessions`

"Sign out everywhere else": ends every session except the current one. **200** `{ "data": { "revoked": 2 } }`.

*More endpoints are added per module.*
