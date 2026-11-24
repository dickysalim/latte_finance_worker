import { conflict } from "./errors";
import { newId } from "./crypto";

export type UserRow = {
  id: string;
  created_at: number;
  email: string;
  email_verified_at: number | null;
  username: string | null;
  name: string;
  household_id: string | null;
  home_household_id: string | null;
  is_active: number;
};

export const DAY = 86400;

export const getUserById = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM tenant_user WHERE id = ?").bind(id).first<UserRow>();

export const getUserByEmail = (db: D1Database, email: string) =>
  db.prepare("SELECT * FROM tenant_user WHERE email = ?").bind(email).first<UserRow>();

/**
 * A username held by another account blocks, unless that account is unverified
 * and older than 24 hours (the release statement then frees the name).
 */
export async function assertUsernameFree(db: D1Database, username: string, selfId: string | null, now: number): Promise<void> {
  const holder = await db
    .prepare("SELECT id, email_verified_at, created_at FROM tenant_user WHERE username = ?")
    .bind(username)
    .first<{ id: string; email_verified_at: number | null; created_at: number }>();
  if (!holder || holder.id === selfId) return;
  if (holder.email_verified_at === null && holder.created_at + DAY < now) return;
  throw conflict("username_taken", "Username Exist, please use other username");
}

/** Frees the username of an unverified account older than 24 hours. Part of the same batch as the write that takes it. */
export const releaseUsernameStmt = (db: D1Database, username: string, selfId: string, now: number) =>
  db
    .prepare(
      "UPDATE tenant_user SET username = NULL, updated_at = ? WHERE username = ? AND id <> ? AND email_verified_at IS NULL AND created_at + 86400 < ?",
    )
    .bind(now, username, selfId, now);

/** Stamps every open, not expired verification link of the user. Expired ones stay (the DB refuses to stamp them). */
export const closeLinksStmt = (db: D1Database, userId: string, now: number) =>
  db
    .prepare("UPDATE tenant_user_email_verification SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND created_at + 86400 >= ?")
    .bind(now, userId, now);

export const insertVerificationStmt = (db: D1Database, userId: string, email: string, tokenHash: string, now: number) =>
  db
    .prepare("INSERT INTO tenant_user_email_verification (id, created_at, user_id, email, token_hash, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
    .bind(newId(), now, userId, email, tokenHash);

export const insertSessionStmt = (db: D1Database, sid: string, userId: string, refreshHash: string, now: number) =>
  db
    .prepare(
      "INSERT INTO tenant_user_session (id, created_at, user_id, refresh_token_hash, previous_refresh_token_hash, last_used_at, ended_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)",
    )
    .bind(sid, now, userId, refreshHash, now);

/** The password hash of a user, or null when there is no password login. */
export const getPasswordHash = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT password_hash FROM tenant_user_login WHERE user_id = ? AND provider = 'password'").bind(userId).first<{ password_hash: string }>())
    ?.password_hash ?? null;

/** Run a batch and map a DB rule error with `onError`; anything else is rethrown. */
export async function runBatch(db: D1Database, stmts: D1PreparedStatement[], onError: (err: unknown) => never): Promise<D1Result[]> {
  try {
    return await db.batch(stmts);
  } catch (err) {
    return onError(err);
  }
}
