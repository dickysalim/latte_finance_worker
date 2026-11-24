# Error codes per route

Body for every error: `{"error": {"code", "message", "fields"?, "details"?}}`. `fields` only on 422 (one message per input field). `details` only where a route says so (today: `invites_waiting`); it carries data, not validation. Message text comes from `design/api_contracts.md`.

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

Rules:
- Value is malformed, the same on any DB state: 422 `validation_failed` with `fields`.
- Value is well formed but the DB state refuses it (taken, used, expired, already done): 409 with its own code. So a taken username is 409 `username_taken` on every route, never 422.
- Wrong password on a route that needs a logged-in or link context: 403 `wrong_password`, never 401, so the app does not try to refresh the token. Only /login uses 401 `invalid_credentials`.
- 429 sends header `Retry-After: 60`.
- One code, one status, on every route.
- Rate limit key: `CF-Connecting-IP`; when missing, key `unknown` (one shared bucket). /login also keys on the cleaned identifier.

## Flow 1 refusals (proposed, waiting for the sheet)

| Route | Refusal text | Status | Code | Extra |
|---|---|---|---|---|
| every route | Too many attempts, please wait a minute | 429 | `rate_limited` | `Retry-After: 60` |
| every route | body over 16 KB | 413 | `payload_too_large` | |
| /normal-signup | Some fields are invalid | 422 | `validation_failed` | fields: email, username, name, password |
| /normal-signup | Username Exist, please use other username | 409 | `username_taken` | |
| /email-verification | This link is not valid or was already used | 409 | `link_invalid` | |
| /email-verification | This link has expired, please request a new one | 409 | `link_expired` | |
| /email-verification | This account is deactivated | 403 | `account_deactivated` | |
| /email-verification | This sign-up was abandoned, please sign up again | 403 | `signup_abandoned` | |
| /email-verification | Wrong password | 403 | `wrong_password` | |
| /email-verification | Email already registered | 409 | `email_taken` | |
| /login | Wrong email, username or password | 401 | `invalid_credentials` | |
| /login | This account is deactivated | 403 | `account_deactivated` | |
| /login | This sign-up was abandoned, please sign up again | 403 | `signup_abandoned` | checked before `email_not_verified`; app says "sign up again", no resend |
| /login | Please verify your email first | 403 | `email_not_verified` | |
| /google-signup, /google-login, /link-google | Google token is not valid | 401 | `google_token_invalid` | |
| /google-signup | Google did not confirm this email | 403 | `google_email_unverified` | |
| /google-signup | This Google account is already registered, please login instead | 409 | `google_taken` | |
| /google-signup | Email already registered, please login with your password and link Google from your profile | 409 | `email_taken` | |
| /google-login | No account for this Google account, please sign up first | 404 | `google_not_registered` | |
| /google-login | This account is deactivated | 403 | `account_deactivated` | |
| /link-google | Google is already linked | 409 | `google_already_linked` | |
| /link-google | This Google account is linked to another user | 409 | `google_taken` | |
| /complete-profile | Profile already completed | 409 | `profile_completed` | |
| /complete-profile | Some fields are invalid | 422 | `validation_failed` | fields: username, name, password |
| /complete-profile | Username Exist, please use other username | 409 | `username_taken` | |
| /first-login-household | Household already set | 409 | `household_already_set` | |
| /first-login-household | Please complete your profile first | 409 | `profile_needed` | |
| /first-login-household | Unknown time zone | 422 | `validation_failed` | fields: timezone |
| /first-login-household | You have waiting invites | 409 | `invites_waiting` | `details.invites`: [{invite_id, household_id, invited_by_name, created_at}], newest first |
| /invite-signup | This invite link is not valid | 409 | `invite_invalid` | |
| /invite-signup | This invite has expired | 409 | `invite_expired` | |
| /invite-signup | Email already registered, please login and accept the invite from your invites list | 409 | `email_taken` | |
| /invite-signup | Username Exist, please use other username | 409 | `username_taken` | |
| /accept-invite, /reject-invite | This invite is not valid | 409 | `invite_invalid` | also the lost race on a double accept |
| /accept-invite | This invite has expired | 409 | `invite_expired` | |
| /accept-invite | You are already in this household | 409 | `already_in_household` | |
| /accept-invite | Please complete your profile first | 409 | `profile_needed` | |

`details` shape for `invites_waiting`: `{"error":{"code":"invites_waiting","message":"You have waiting invites","details":{"invites":[...]}}}`.

Outside Flow 1 (for the sheet later): /invite-create 429 `invite_limit`, /change-email-request 429 `too_soon`, "Current password is wrong" 403 `wrong_password`, "No password is set" 409 `no_password`.


## Codes added while building Flow 1

| Route | Status | Code | When |
|---|---|---|---|
| /google-signup, /google-login | 409 | `google_not_configured` | `GOOGLE_CLIENT_IDS` is empty (no Google client yet). |
| /refresh | 401 | `session_ended` | unknown token, ended session, or a reused old token after the 60 second grace |
| /refresh | 401 | `session_expired` | idle for more than 30 days |
| /refresh | 403 | `account_deactivated` | the user is deactivated; the session is ended |
| /complete-profile | 409 | `profile_completed` | the user already has a username |

Replies (snake_case): /login and /google-login send `access_token`, `refresh_token`, `household_needed`, `profile_needed`. /refresh sends `access_token`, `refresh_token`. /first-login-household and /accept-invite send `access_token`, `household_id`. /invites sends `invites` (`invite_id`, `household_id`, `invited_by_name`, `created_at`). /normal-signup is 202 `{message}`. /email-verification sends `{verified: true}`. /complete-profile sends `{profile_needed: false}`. /logout and /logout-all send `{}`. /me sends id, email, username, name, household_id, home_household_id, household_owner_name (owner's stored lowercase name, null without a household), profile_needed, household_needed, can_leave, has_password, has_google.
