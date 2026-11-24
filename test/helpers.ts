import { env } from "cloudflare:workers";
import { expect } from "vitest";

export const db = env.DB;

let n = 0;
export const uid = () => crypto.randomUUID();
export const nextN = () => ++n;

export const run = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run();
export const row = <T = any>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();
export const rows = <T = any>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);

/** The statement must be refused by the database, with `pattern` in the error message. */
export async function rejects(p: Promise<unknown>, pattern: RegExp | string) {
  await expect(p).rejects.toThrow(pattern);
}

/**
 * Household with one owner, built in the only order the circular keys allow:
 * household -> user -> member -> user.household_id / home_household_id -> household.owner_id.
 */
export async function seedHousehold() {
  const i = nextN();
  const hh = uid();
  const owner = uid();
  await run("INSERT INTO tenant_household (id) VALUES (?)", hh);
  await run("INSERT INTO tenant_user (id, email, email_verified_at, username, name) VALUES (?, ?, unixepoch(), ?, 'alice')", owner, `alice${i}@example.com`, `alice${i}`);
  await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", hh, owner);
  await run("UPDATE tenant_user SET household_id = ?, home_household_id = ? WHERE id = ?", hh, hh, owner);
  await run("UPDATE tenant_household SET owner_id = ? WHERE id = ?", owner, hh);
  await run("INSERT INTO app_household_setting (household_id, updated_by) VALUES (?, ?)", hh, owner);
  return { hh, owner };
}

/** A user with no household yet. */
export async function seedUser(over: { email?: string; username?: string | null } = {}) {
  const i = nextN();
  const id = uid();
  const email = over.email ?? `bob${i}@example.com`;
  const username = over.username === undefined ? `bob${i}` : over.username;
  await run("INSERT INTO tenant_user (id, email, email_verified_at, username, name) VALUES (?, ?, unixepoch(), ?, 'bob')", id, email, username);
  return { id, email };
}

/** Add an existing user to a household and make it his current one. */
export async function joinHousehold(userId: string, hh: string) {
  await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", hh, userId);
  await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", hh, userId);
}

type Ctx = { hh: string; owner: string };

export async function seedAccount(c: Ctx, over: Record<string, unknown> = {}) {
  const id = uid();
  await run(
    "INSERT INTO app_financial_account (id, created_by, household_id, updated_by, name, type) VALUES (?, ?, ?, ?, ?, ?)",
    id, c.owner, c.hh, c.owner, (over.name as string) ?? `bank ${nextN()}`, (over.type as string) ?? "bank_account",
  );
  return id;
}

export async function seedCard(c: Ctx) {
  const id = uid();
  await run(
    "INSERT INTO app_financial_account (id, created_by, household_id, updated_by, name, type, credit_limit, bill_day) VALUES (?, ?, ?, ?, ?, 'credit_card', 5000000, 15)",
    id, c.owner, c.hh, c.owner, `card ${nextN()}`,
  );
  return id;
}

export async function seedGroup(c: Ctx, type: "expense" | "income" = "expense") {
  const id = uid();
  await run("INSERT INTO app_transaction_group (id, created_by, household_id, updated_by, name, type) VALUES (?, ?, ?, ?, ?, ?)", id, c.owner, c.hh, c.owner, `group ${nextN()}`, type);
  return id;
}

export async function seedCategory(c: Ctx, type: "expense" | "income" = "expense", groupId?: string) {
  const id = uid();
  const g = groupId ?? (await seedGroup(c, type));
  await run("INSERT INTO app_transaction_category (id, created_by, household_id, updated_by, group_id, name) VALUES (?, ?, ?, ?, ?, ?)", id, c.owner, c.hh, c.owner, g, `category ${nextN()}`);
  return { id, groupId: g };
}

/** Insert an app_transaction with sane defaults; `over` replaces any column. */
export async function insertTransaction(c: Ctx, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id: uid(), created_by: c.owner, household_id: c.hh, updated_by: c.owner,
    date: "2026-11-20", name: "lunch", amount: 25000, transaction_type: "adjust_up",
    ...over,
  };
  const cols = Object.keys(base);
  await run(`INSERT INTO app_transaction (${cols.map((k) => (k === "date" ? '"date"' : k)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((k) => base[k]));
  return base.id as string;
}
