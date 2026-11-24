# Latte Finance worker

Backend for **Latte Finance**, a household money tracker: shared households, accounts, transactions, budgets, loans, credit card bills and recurring bills.

## Stack
- Cloudflare Workers + [Hono](https://hono.dev) (TypeScript)
- Cloudflare D1 (SQLite) with the rules enforced in the database: CHECK constraints, partial unique indexes, composite foreign keys and triggers
- Vitest with `@cloudflare/vitest-plugin` (tests run against a local D1)

## Database
17 tables in two groups: `tenant_*` (users, logins, households, members, invites, email verification, password reset, sessions) and `app_*` (financial accounts, transactions, groups, categories, budgets, credit card bills, recurring transactions, loans, household settings). See `migrations/`.

The schema tests in `test/` check each trigger and important CHECK: a valid insert passes, an invalid one is refused.

## Run the tests
```bash
npm install
npm test
npm run typecheck
```

## Local dev
```bash
npm run dev
```
`GET /health` answers `{"status":"ok"}`. Local runs use a local D1 copy; nothing here needs a secret. Local secrets, if any, go in `.dev.vars` (git-ignored).

## Contributing notes
Read `CLAUDE.md` first: it lists the rules on secrets, personal data and Wrangler login.
