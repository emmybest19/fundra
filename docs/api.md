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
    "details": [{ "path": "amount", "message": "Invalid string: must match pattern /^[1-9][0-9]*$/" }],
    "requestId": "8f0c..."
  }
}
```

| Field | Present | Meaning |
|---|---|---|
| `code` | always | Stable, machine-readable. **Branch on this, not on `message`.** |
| `message` | always | Human-readable. For 5xx it is always the generic `An unexpected error occurred.` |
| `details` | validation errors | One entry per problem. `path` is the dotted field path, omitted for request-level problems. Submitted values are never echoed back |
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
