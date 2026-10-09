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
| 409 | `CONFLICT` | Conflicts with current state (duplicate, wrong status, or an unexpected clash with an existing record) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | `Idempotency-Key` header missing or malformed (see [Idempotency](#idempotency)) |
| 409 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` | A request with the same key is still being processed |
| 413 | `PAYLOAD_TOO_LARGE` | Request body exceeds the size limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body type not accepted, or the file's contents don't match its `Content-Type` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Key already used for a different request |
| 401 | `INVALID_CREDENTIALS` | Email/phone or password incorrect (deliberately doesn't say which) |
| 403 | `ACCOUNT_LOCKED` | Too many failed sign-ins; locked for 15 minutes |
| 403 | `ACCOUNT_DISABLED` | Account suspended or deactivated (only shown after a correct password) |
| 403 | `ACCOUNT_NOT_ACTIVE` | Email and phone must be verified before this action (e.g. moving money) |
| 409 | `HANDLE_TAKEN` | Handle already in use |
| 409 | `ACCOUNT_EXISTS` | Email or phone already registered (deliberately doesn't say which) |
| 401 | `ACCESS_TOKEN_EXPIRED` | Access token expired; refresh and retry (see [Authenticated requests](#authenticated-requests)) |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token unknown, expired, or its session ended |
| 401 | `REFRESH_TOKEN_REUSED` | An already-used refresh token was presented; the session was ended as a precaution |
| 400 | `INVALID_OTP` | Code wrong, expired, already used, or out of attempts (5) |
| 429 | `OTP_COOLDOWN` | A code was sent less than 60 seconds ago |
| 409 | `ALREADY_VERIFIED` | That email or phone is already verified |
| 403 | `INCORRECT_PASSWORD` | Re-authentication failed for a sensitive action. Counts toward the sign-in lockout. Not a 401: the access token is still valid |
| 409 | `NAME_LOCKED` | Name can't change once any KYC tier is approved, or while a submission is under review; contact support |
| 409 | `CONTACT_UNAVAILABLE` | The new email/phone was taken by another account before you confirmed |
| 409 | `ACCOUNT_HAS_BALANCE` | Deactivation needs every wallet at zero; withdraw or transfer first |
| 409 | `ACCOUNT_HAS_PENDING_TRANSACTIONS` | Deactivation waits until no transaction is pending or processing |
| 422 | `INSUFFICIENT_FUNDS` | Your available balance (excluding money on hold) is too low (money movement, from Stage 13) |
| 422 | `WALLET_FROZEN` | Your wallet is restricted; contact support |
| 422 | `WALLET_CLOSED` | Your wallet is closed |
| 422 | `LIMIT_PER_TRANSACTION_EXCEEDED` | Amount + fee is above your tier's per-transaction limit (money movement, from Stage 13) |
| 422 | `LIMIT_DAILY_OUTFLOW_EXCEEDED` | Would take today's outgoing total (Lagos day, fees included) over your tier's daily limit; the message says how much is left |
| 422 | `LIMIT_MAX_BALANCE_EXCEEDED` | A deposit would take your balance over your tier's maximum |
| 422 | `RECIPIENT_CANNOT_RECEIVE` | The recipient can't receive this amount; deliberately says nothing about their tier, limit or balance |
| 403 | `WALLET_SELF_ACTION` | Admins can't change the status of their own wallet |
| 409 | `KYC_TIER_ORDER` | Tiers are taken in order; complete the previous tier first |
| 409 | `KYC_TIER_ALREADY_APPROVED` | You're already verified at this tier or higher |
| 409 | `KYC_UNDER_REVIEW` | A Tier 3 submission is being reviewed; documents and address can't change until it's decided |
| 409 | `KYC_STATE_CHANGED` | Your KYC changed while the request was running (e.g. a parallel request); reload and retry |
| 422 | `VALIDATION_ERROR` | Well-formed request with invalid fields; see `details` |
| 422 | `UNPROCESSABLE` | Valid request that breaks a business rule. Modules use more specific codes (e.g. `INSUFFICIENT_FUNDS`) as they are added |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server failure; details are only in the logs |
| 503 | `SERVICE_UNAVAILABLE` | A dependency (database, Redis, the KYC provider) is unavailable, or the database was briefly busy (deadlock, lock timeout); safe to retry after `Retry-After` seconds |

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
| `403 FORBIDDEN` | Signed in, but your roles don't grant this action | Don't retry |
| `403 ACCOUNT_NOT_ACTIVE` | Email and phone not yet verified | Send the user through verification |

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

### Verification (one-time codes)

Codes are 6 digits, valid for **10 minutes**, usable **once**, with **5 attempts** per code; a new code can be requested every **60 seconds**. Requesting a new code replaces the old one. Rate limit: 10 per 15 minutes per IP.

| Endpoint | Auth | Body | Success |
|---|---|---|---|
| `POST /api/v1/auth/verify/email/request` | Bearer | — | **202** `{ "data": { "sent": true } }`; code emailed |
| `POST /api/v1/auth/verify/email/confirm` | Bearer | `{ "code": "123456" }` | **200** `{ "data": { "user": { … } } }` |
| `POST /api/v1/auth/verify/phone/request` | Bearer | — | **202**; code sent by SMS |
| `POST /api/v1/auth/verify/phone/confirm` | Bearer | `{ "code": "123456" }` | **200** with the updated user |

When **both** email and phone are verified, the account's `status` becomes `ACTIVE`. Errors: `400 INVALID_OTP`, `409 ALREADY_VERIFIED`, `429 OTP_COOLDOWN`, `503 SERVICE_UNAVAILABLE` (code storage unavailable: try later; codes are never skipped).

### Password reset

#### `POST /api/v1/auth/password/forgot`

```json
{ "identifier": "emma@fundra.dev" }
```

**Always 202** `{ "data": { "sent": true } }`, even if no such account exists, so the endpoint can't be used to discover accounts. If the account exists and is active, a code is sent to the channel you named: email for an email address, SMS for a phone number. Rate limit: 5 per 15 minutes per IP (shared with `/reset`).

#### `POST /api/v1/auth/password/reset`

```json
{ "identifier": "emma@fundra.dev", "code": "123456", "newPassword": "brand new secret 9" }
```

**204**. The new password follows the registration rules. On success **every session is signed out** (all devices must sign in again), any sign-in lockout is cleared, and a "password changed" alert is emailed. Errors: `400 INVALID_OTP` (also for unknown or disabled accounts), `422` (password rules; the code is *not* used up), `429`, `503`.

### Users (the signed-in user)

All require `Authorization: Bearer`. Every route acts on **you**; admins manage other users through the admin endpoints (Stage 19). Routes marked *sensitive* re-check your password or send codes, and share a limit of **10 per 15 minutes per user** (keyed by account, not IP).

#### `GET /api/v1/users/me`

**200**. Your profile:

```json
{
  "data": {
    "user": {
      "id": "01a0…", "email": "emma@fundra.dev", "emailVerified": true,
      "phone": "+2348012345678", "phoneVerified": true,
      "handle": "emma_o", "firstName": "Emma", "lastName": "Okafor",
      "status": "ACTIVE", "createdAt": "…", "updatedAt": "…",
      "roles": ["USER"],
      "kyc": { "status": "NOT_STARTED", "tier": 0 },
      "canTransact": true
    }
  }
}
```

`canTransact` follows the same rule as the money endpoints: only `ACTIVE` accounts can move money.

#### `PATCH /api/v1/users/me`

Any of `firstName`, `lastName` and `handle`, at least one. Fields are normalised the same way as at registration. **200** with the updated profile. Only fields that actually change are saved and audited.

| Error | When |
|---|---|
| `409 HANDLE_TAKEN` | Someone else has that handle |
| `409 NAME_LOCKED` | KYC is `PENDING`, `IN_REVIEW` or `APPROVED`: your name is what KYC verifies. The handle can still change |
| `422 VALIDATION_ERROR` | Unknown field (email, phone and status have their own flows), or invalid value |

#### `GET /api/v1/users/me/preferences` · `PATCH /api/v1/users/me/preferences`

Which notifications you receive, and on which channels. `GET` returns the full object, with defaults filled in. `PATCH` takes any subset and returns the full result.

```json
{
  "notifications": {
    "transactions": { "email": true,  "sms": false, "push": true },
    "security":     { "email": true,  "sms": true,  "push": true },
    "marketing":    { "email": false, "sms": false, "push": false }
  }
}
```

The defaults are shown above. Security emails **can't be turned off** (`422`): they're how you learn about a takeover. Marketing is opt-in. Unknown keys are rejected rather than ignored.

#### Changing email or phone (*sensitive*)

Two steps, so the account never holds an address you don't control:

| Step | Endpoint | Body | Success |
|---|---|---|---|
| 1 | `POST /api/v1/users/me/email` | `{ "newEmail": "…", "password": "…" }` | **202** `{ "data": { "sent": true } }`; code sent to the **new** address |
| 2 | `POST /api/v1/users/me/email/confirm` | `{ "newEmail": "…", "code": "123456" }` | **200** with the updated profile |
| 1 | `POST /api/v1/users/me/phone` | `{ "newPhone": "…", "password": "…" }` | **202**; code sent by SMS to the new number |
| 2 | `POST /api/v1/users/me/phone/confirm` | `{ "newPhone": "…", "code": "123456" }` | **200** |

- Your current address keeps working until step 2. Once confirmed, the new address is **already verified**. If it was the last unverified contact, your status becomes `ACTIVE`.
- The code only confirms the address it was sent to. A code for `a@x.dev` can't confirm `b@x.dev`.
- The **old** address gets a "your email/phone was changed" alert.
- An address that belongs to another account gets the same `202`, but no code is sent, so this can't be used to discover accounts.
- Codes follow the [verification rules](#verification-one-time-codes): 10 minutes, single use, 5 attempts, 60-second cooldown.

Errors: `403 INCORRECT_PASSWORD`, `403 ACCOUNT_LOCKED`, `422` (same as your current address), `400 INVALID_OTP`, `409 CONTACT_UNAVAILABLE`, `429 OTP_COOLDOWN`, `503`.

#### `POST /api/v1/users/me/password` (*sensitive*)

```json
{ "currentPassword": "purple elephant 42", "newPassword": "green giraffe 77 tall" }
```

**200**, with a new token pair in the same shape as `/auth/refresh` (`Cache-Control: no-store`):

```json
{ "data": { "tokenType": "Bearer", "accessToken": "…", "accessTokenExpiresAt": "…", "refreshToken": "fnd_rt_…", "refreshTokenExpiresAt": "…" } }
```

On success:

- **Every** session ends, this one included, so all earlier access and refresh tokens stop working on every device.
- This device continues with the tokens in the response. Switch to them straight away.
- Other devices must sign in again with the new password.
- A "password changed" alert is emailed.

The new password follows the registration rules, must not contain your handle or email name, and must differ from the current one.

| Error | When |
|---|---|
| `403 INCORRECT_PASSWORD` | `currentPassword` is wrong (counts toward the sign-in lockout) |
| `403 ACCOUNT_LOCKED` | Too many wrong passwords; try again in 15 minutes |
| `422 VALIDATION_ERROR` | New password breaks a rule. Nothing changes and you stay signed in |

Forgot the current password? Use [password reset](#password-reset) instead.

#### `POST /api/v1/users/me/deactivate` (*sensitive*)

```json
{ "password": "…", "reason": "SWITCHING_PROVIDER" }
```

`reason` is optional, one of `NO_LONGER_NEEDED`, `SWITCHING_PROVIDER`, `PRIVACY_CONCERNS`, `TOO_EXPENSIVE`, `OTHER`. Free text isn't accepted, because the reason is kept in the audit log.

**204**. On success:

- the status becomes `DEACTIVATED`;
- every wallet is closed;
- every session ends, so all tokens stop working immediately;
- a confirmation email is sent.

Signing in afterwards gives `403 ACCOUNT_DISABLED`. Nothing is deleted, and your email, phone and handle stay reserved. Reactivation goes through support.

| Error | When |
|---|---|
| `403 INCORRECT_PASSWORD` / `403 ACCOUNT_LOCKED` | Password check failed / too many failures |
| `409 ACCOUNT_HAS_BALANCE` | A wallet still holds money (including amounts on hold) |
| `409 ACCOUNT_HAS_PENDING_TRANSACTIONS` | A transaction to or from you is still pending or processing |

### KYC (identity verification)

Three tiers, taken in order (limits per tier: [ARCHITECTURE.md D3](ARCHITECTURE.md#d3--kyc-tiers-and-limits)). All routes need authentication; every route except `GET` also needs a verified email and phone (`403 ACCOUNT_NOT_ACTIVE`).

| Tier | You send | Decided |
|---|---|---|
| 1 | Date of birth (18 or older) | At once |
| 2 | BVN or NIN, checked against your name and date of birth | At once |
| 3 | An ID document, a utility bill and your address | By a reviewer, after `202` |

Your **legal name locks** when Tier 1 is approved: it's what KYC verifies.

#### `GET /api/v1/kyc`

```json
{
  "data": {
    "kyc": {
      "tier": 2, "status": "APPROVED", "requestedTier": null, "rejectionReason": null,
      "submittedAt": "…", "reviewedAt": "…",
      "identityNumber": { "type": "BVN" },
      "address": null,
      "documents": [
        { "id": "…", "type": "PASSPORT", "mimeType": "image/png", "sizeBytes": 48211, "status": "PENDING", "uploadedAt": "…" }
      ],
      "next": { "tier": 3, "requires": ["idDocument", "utilityBill", "address"] },
      "limits": {
        "current": { "NGN": { "perTransaction": "10000000", "dailyOutflow": "20000000", "maxBalance": "50000000" } },
        "next":    { "NGN": { "perTransaction": "500000000", "dailyOutflow": "500000000", "maxBalance": null } }
      }
    }
  }
}
```

- `status` is the state of your **latest** request: `NOT_STARTED`, `PENDING` (queued for review), `IN_REVIEW`, `APPROVED` or `REJECTED`. `tier` is what's approved, and a rejection never lowers it.
- `identityNumber` says which number is on file, never the number itself.
- `next` is `null` at Tier 3.
- `limits` shows your limits now and after upgrading, per currency, in kobo strings: `perTransaction` and `dailyOutflow` (both count amount + fee; the day is the Lagos calendar day) and `maxBalance` (`null` = unlimited). `current` is `null` at tier 0, where no money can move; `next` is `null` at Tier 3. Admins can change limits, and a change applies to the next transaction.

#### `POST /api/v1/kyc/tier-1`

```json
{ "dateOfBirth": "1995-04-12" }
```

**200** with the `kyc` object (Tier 1, `APPROVED`). Your NGN wallet is created in the same step, with a 10-digit account number for receiving money. Errors: `422` (not a real date, or under 18), `409 KYC_TIER_ALREADY_APPROVED`.

#### `POST /api/v1/kyc/tier-2`

```json
{ "type": "BVN", "idNumber": "22212345678" }
```

`type` is `BVN` or `NIN`; `idNumber` is 11 digits (spaces are ignored). Rate limit: **5 per day** per user.

**200** with the `kyc` object, in one of two states:

- **Approved:** `tier: 2`, `status: "APPROVED"`.
- **Rejected:** `status: "REJECTED"` with a `rejectionReason`. You stay at Tier 1 and can try again. The reason is the same whatever went wrong (mismatch, number not found, number already linked to another account), so the response can't reveal anything about someone else's number. The number isn't kept.

| Error | When |
|---|---|
| `409 KYC_TIER_ORDER` | Tier 1 isn't approved yet |
| `409 KYC_TIER_ALREADY_APPROVED` | Already Tier 2 or higher |
| `429 RATE_LIMITED` | More than 5 checks today |
| `503 SERVICE_UNAVAILABLE` | The verification provider is down. Nothing was saved and the attempt isn't counted as a rejection; retry later |

#### `PUT /api/v1/kyc/documents/:type`

Uploads one Tier 3 document. Send the **file itself** as the body (not multipart or JSON):

```http
PUT /api/v1/kyc/documents/UTILITY_BILL
Content-Type: application/pdf

%PDF-1.7 …
```

- `type`: `NATIONAL_ID`, `PASSPORT`, `DRIVERS_LICENSE`, `VOTERS_CARD`, `UTILITY_BILL` or `SELFIE`.
- `Content-Type`: `image/jpeg`, `image/png` or `application/pdf`, up to 5 MB. The file's contents must match it.
- Uploading a type again replaces your earlier upload of that type.
- Requires Tier 2. Rate limit: 20 per hour per user.

**201**:

```json
{ "data": { "document": { "id": "…", "type": "UTILITY_BILL", "mimeType": "application/pdf", "sizeBytes": 91022, "status": "PENDING", "uploadedAt": "…" } } }
```

Errors: `415 UNSUPPORTED_MEDIA_TYPE`, `413 PAYLOAD_TOO_LARGE`, `422` (empty file or unknown type), `409 KYC_TIER_ORDER`, `409 KYC_UNDER_REVIEW`.

#### `POST /api/v1/kyc/tier-3`

```json
{ "address": { "line1": "1 Marina", "line2": "Flat 4", "city": "Lagos", "state": "Lagos", "country": "NG", "postalCode": "101001" } }
```

`line2` and `postalCode` are optional; `country` is a two-letter code and defaults to `NG`. You need to have uploaded **one ID document** (`NATIONAL_ID`, `PASSPORT`, `DRIVERS_LICENSE` or `VOTERS_CARD`) **and a `UTILITY_BILL`**.

**202** with the `kyc` object (`status: "PENDING"`, `requestedTier: 3`). A reviewer decides. While it's `PENDING` or `IN_REVIEW`, documents and the address can't change (`409 KYC_UNDER_REVIEW`). If it's rejected, `rejectionReason` says what to fix: upload again and resubmit.

Errors: `422` (missing documents are listed under `documents`), `409 KYC_TIER_ORDER`, `409 KYC_TIER_ALREADY_APPROVED`, `409 KYC_UNDER_REVIEW`.

### Wallets

Your NGN wallet is created when Tier 1 is approved. Both routes need authentication, and responses are never cached (`Cache-Control: no-store`).

#### `GET /api/v1/wallets`

```json
{
  "data": {
    "wallets": [
      {
        "id": "…", "currency": "NGN", "accountNumber": "0123456789", "status": "ACTIVE",
        "balance": { "ledger": "1500000", "available": "1200000", "onHold": "300000" },
        "createdAt": "…"
      }
    ]
  }
}
```

An empty list before Tier 1.

- `balance` is in kobo strings. `available` is what you can spend; `onHold` is reserved for something in progress (e.g. a pending withdrawal); `ledger = available + onHold`.
- `accountNumber` is for receiving money. It has a check digit, so a mistyped number is rejected rather than reaching someone else.
- `status`:

| Status | Meaning |
|---|---|
| `ACTIVE` | Normal |
| `FROZEN` | Temporarily restricted: no money in or out. Contact support |
| `CLOSED` | The account was deactivated |

#### `GET /api/v1/wallets/:id`

**200** with `{ "data": { "wallet": { … } } }`, the same shape as above. A wallet that doesn't exist **or isn't yours** is `404 NOT_FOUND`; a malformed ID is `422`.

*More endpoints are added per module.*
