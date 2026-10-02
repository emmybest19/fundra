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
| 413 | `PAYLOAD_TOO_LARGE` | Request body exceeds the size limit |
| 422 | `VALIDATION_ERROR` | Well-formed request with invalid fields; see `details` |
| 422 | `UNPROCESSABLE` | Valid request that breaks a business rule. Modules use more specific codes (e.g. `INSUFFICIENT_FUNDS`) as they are added |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server failure; details are only in the logs |
| 503 | `SERVICE_UNAVAILABLE` | A dependency (database, Redis) is unavailable |

Module-specific codes are registered in [error-codes.ts](../src/common/errors/error-codes.ts) and listed here as each module is built.

---

## Endpoints

*Added per module.*
