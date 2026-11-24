# Latte Finance worker: rules for Claude and contributors

This repo is **public** and is the owner's showcase. Treat every file, commit and log line as world-readable.

## What this is
Cloudflare Worker (Hono, TypeScript) + D1 (SQLite) backend for Latte Finance. Tests: Vitest with `@cloudflare/vitest-plugin`.
- `migrations/`: the schema. 17 tables, every CHECK, UNIQUE / partial index, composite FK and TRIGGER from the design.
- `src/`: the worker. `test/`: schema tests (one per trigger and important CHECK) and route tests.
- Commands: `npm test`, `npm run typecheck`.

## Source of truth
- The design lives in `../design/` (`table_design.md`, `api_contracts.md`, `stories.md`). They copy the Claude Sheets artifact; if they disagree, the sheet wins.
- Do not change the design. Raise gaps or conflicts with the PM / owner.
- Folders named `latte_factor_*` (`latte_factor_app`, `latte_factor_worker`, `latte_factor_agent`) are **legacy, reference only**. Never edit them, never deploy them.

## Secrets: never commit them
- Never commit API tokens, the JWT secret, the Resend key, the Google client secret, `.dev.vars`, `.env*`, `.wrangler-home/` or `.wrangler/`.
- Production secrets go through `wrangler secret put` only. Local secrets live in `.dev.vars` only (git-ignored).
- Never paste a secret into code, fixtures, tests, logs, commit messages, PR text or chat.
- Never ask the user for a token. Wrangler uses the OAuth login described below.
- Run `git diff --cached` and read it for secrets and personal data before **every** commit.

## Personal data: never commit it
- No real emails, names, phone numbers or real financial numbers in code, fixtures, seeds, tests, logs or commit messages.
- Use fake data: `alice@example.com`, `bob@example.com`, round made-up amounts.

## Wrangler policy (mandatory)
- Never run `wrangler login` with the default `HOME`. Credentials must never land in `~/.wrangler` or `~/Library/Preferences/.wrangler`.
- Every wrangler command runs with the project-local config, set on the command only:

  `HOME="$PWD/.wrangler-home" XDG_CONFIG_HOME="$PWD/.wrangler-home/cfg" npx wrangler <command>`

- Run `whoami` with the same prefix before any deploy or remote DB change, and confirm the account is the intended one (`c9cb13e9ce172aecf02828557cd72f20`).
- `.wrangler-home/` holds OAuth tokens. It stays in `.gitignore`.
- If a global login exists (`~/.wrangler/config/default.toml`), tell the user and suggest `npx wrangler logout`. Do not log in globally.
- `wrangler.toml` never sets `remote = true` for D1. Remote changes go through `d1 migrations apply --remote` with the prefix above, and only after listing the remote tables first.

## Database rules
- The schema is the safety net: keep CHECKs, UNIQUE / partial indexes, composite FKs and triggers in the migrations, not only in routes.
- Once a migration has been applied to the remote DB, never edit it. Add a new numbered migration.
- Every trigger and important CHECK needs a test: a valid insert passes, an invalid one fails.
- Insert order is forced by the circular keys: household (owner NULL), user (household NULL), member, set `tenant_user.household_id` and `home_household_id`, set `tenant_household.owner_id`.
- Soft delete only (`is_active` 1 to 0). Times are epoch seconds. Money is an integer, always positive; the direction comes from `transaction_type`.
- A CHECK that evaluates to NULL passes. Write `IS NOT NULL` explicitly, and use `date(x) IS x`, not `date(x) = x`.

## Before every commit
1. `npm test` and `npm run typecheck` pass.
2. `git diff --cached`: no secrets, no personal data.
3. Commit message is plain and contains no private data.
