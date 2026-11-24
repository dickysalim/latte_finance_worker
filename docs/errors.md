# Error codes per route

Body for every error: `{"error": {"code", "message", "fields"?}}`. `fields` only on 422. Message text comes from `design/api_contracts.md`.

Codes that exist for every route (from the convention rows):

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | body is not JSON |
| 401 | `token_invalid` | missing, malformed or bad-signature access token |
| 401 | `token_expired` | access token expired (the app then calls /refresh) |
| 403 | `forbidden` | logged in but not allowed |
| 404 | `not_found` | unknown route, or a row id not in the user's household |
| 409 | `conflict` | request refused by the current state; fallback for a DB UNIQUE, FK or trigger error |
| 413 | `payload_too_large` | body over 16 KB |
| 422 | `validation_failed` | invalid fields, one message per field |
| 429 | `rate_limited` | over the rate limit |

409 codes that tell cases apart: `email_taken`, `username_taken`, `link_invalid`, `link_expired`, `household_already_set`, `profile_needed`, `invites_waiting`.

Per-route codes are added here as each route is built.
