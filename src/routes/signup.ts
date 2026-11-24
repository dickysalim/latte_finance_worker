import { Hono } from "hono";
import type { AppEnv } from "../lib/http";
import { clientIp, limit } from "../lib/http";
import { readBody } from "../lib/body";
import { ApiError, conflict, mapDbError } from "../lib/errors";
import { hashPassword, hashToken, newId, verifyPassword } from "../lib/crypto";
import {
  assertUsernameFree, closeLinksStmt, getPasswordHash, getUserByEmail, getUserById, insertVerificationStmt,
  releaseUsernameStmt, runBatch, DAY,
} from "../lib/accounts";
import { clean, emailError, failOnFields, nameError, passwordError, requiredString, usernameError } from "../lib/validate";
import { sendAlreadyRegisteredEmail, sendVerificationEmail } from "../lib/mail";

export const signup = new Hono<AppEnv>();

const googleAudiences = (ids: string) => ids.split(",").map((s) => s.trim()).filter(Boolean);
const message = (text: string) => ({ message: text });

// ------------------------------------------------------------------ /normal-signup
signup.post("/normal-signup", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `signup:${clientIp(c)}`, 5);

  const email = clean(body.email);
  const username = clean(body.username);
  const name = clean(body.name);
  failOnFields({
    email: emailError(email),
    username: usernameError(username),
    name: nameError(name),
    password: passwordError(body.password),
  });
  const password = body.password as string;
  const now = deps.now();
  const ok = c.json(message("Check your email to continue"), 202);

  const existing = await getUserByEmail(db, email!);
  if (existing && existing.email_verified_at !== null) {
    // The notice goes at most once per 60 seconds per address (story 54); the reply stays the same either way.
    if (await deps.rateLimit(`notice:${email}`, 1, 60)) await sendAlreadyRegisteredEmail(deps, email!);
    return ok;
  }

  const userId = existing?.id ?? newId();
  await assertUsernameFree(db, username!, userId, now);

  const passwordHash = await hashPassword(password);
  const token = deps.randomToken();
  const tokenHash = await hashToken(token);
  // Every statement that touches an existing account is guarded: it must still be unverified.
  const stillUnverified = "EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND email_verified_at IS NULL)";
  const stmts = [
    releaseUsernameStmt(db, username!, userId, now),
    existing
      ? db
          .prepare("UPDATE tenant_user SET username = ?, name = ?, created_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL")
          .bind(username, name, now, now, userId)
      : db
          .prepare(
            "INSERT INTO tenant_user (id, created_at, email, email_verified_at, username, name, household_id, home_household_id, is_active, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, 1, ?)",
          )
          .bind(userId, now, email, username, name, now),
    db
      .prepare(`UPDATE tenant_user_login SET password_hash = ?, updated_at = ? WHERE user_id = ? AND provider = 'password' AND ${stillUnverified}`)
      .bind(passwordHash, now, userId, userId),
    db
      .prepare(
        `INSERT INTO tenant_user_login (id, created_at, provider, provider_user_id, user_id, password_hash, last_login_at, updated_at)
         SELECT ?, ?, 'password', ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM tenant_user_login WHERE user_id = ? AND provider = 'password') AND ${stillUnverified}`,
      )
      .bind(newId(), now, userId, userId, passwordHash, now, userId, userId),
    closeLinksStmt(db, userId, now),
    db
      .prepare(
        `INSERT INTO tenant_user_email_verification (id, created_at, user_id, email, token_hash, used_at)
         SELECT ?, ?, ?, ?, ?, NULL WHERE ${stillUnverified}`,
      )
      .bind(newId(), now, userId, email, tokenHash, userId),
  ];
  try {
    await runBatch(db, stmts, mapDbError);
  } catch (err) {
    // Someone registered this email between the check and the write: answer like any other known email.
    if (err instanceof ApiError && err.code === "email_taken") return ok;
    throw err;
  }
  await sendVerificationEmail(deps, c.env.APP_URL, email!, token);
  return ok;
});

// ------------------------------------------------------------------ /email-verification-resend
signup.post("/email-verification-resend", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `resend:${clientIp(c)}`, 5);

  failOnFields({ identifier: requiredString(body.identifier, "Enter your email or username") });
  const identifier = clean(body.identifier)!;
  const now = deps.now();
  const same = c.json(message("If an account needs verifying, we sent a new link"));

  const user = await db
    .prepare("SELECT * FROM tenant_user WHERE (email = ? OR username = ?) AND is_active = 1 AND email_verified_at IS NULL AND username IS NOT NULL")
    .bind(identifier, identifier)
    .first<{ id: string; email: string }>();
  if (!user) return same;
  const latest = await db
    .prepare("SELECT MAX(created_at) AS at FROM tenant_user_email_verification WHERE user_id = ?")
    .bind(user.id)
    .first<{ at: number | null }>();
  if (latest?.at != null && latest.at + 60 > now) return same;

  const token = deps.randomToken();
  await db.batch([closeLinksStmt(db, user.id, now), insertVerificationStmt(db, user.id, user.email, await hashToken(token), now)]);
  await sendVerificationEmail(deps, c.env.APP_URL, user.email, token);
  return same;
});

// ------------------------------------------------------------------ /email-verification
signup.post("/email-verification", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `verify:${clientIp(c)}`, 5);

  failOnFields({ token: requiredString(body.token, "Token is required") });
  const now = deps.now();
  const record = await db
    .prepare("SELECT id, user_id, email, created_at, used_at FROM tenant_user_email_verification WHERE token_hash = ?")
    .bind(await hashToken(body.token as string))
    .first<{ id: string; user_id: string; email: string; created_at: number; used_at: number | null }>();
  if (!record || record.used_at !== null) throw conflict("link_invalid", "This link is not valid or was already used");
  if (now > record.created_at + DAY) throw conflict("link_expired", "This link has expired, please request a new one");

  const user = (await getUserById(db, record.user_id))!;
  if (user.is_active === 0) throw new ApiError(403, "account_deactivated", "This account is deactivated");
  if (user.email_verified_at === null && user.username === null) {
    throw new ApiError(403, "signup_abandoned", "This sign-up was abandoned, please sign up again");
  }
  const hash = await getPasswordHash(db, user.id);
  if (hash !== null) {
    const password = body.password;
    if (typeof password !== "string" || !(await verifyPassword(password, hash))) {
      throw new ApiError(403, "wrong_password", "Wrong password");
    }
  }
  const other = await db.prepare("SELECT 1 AS x FROM tenant_user WHERE email = ? AND id <> ?").bind(record.email, user.id).first();
  if (other) throw conflict("email_taken", "Email already registered");

  // Both statements carry the guard "the user still holds a username or is verified".
  const holds = "EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND (username IS NOT NULL OR email_verified_at IS NOT NULL))";
  const results = await runBatch(
    db,
    [
      db
        .prepare(`UPDATE tenant_user_email_verification SET used_at = ? WHERE id = ? AND used_at IS NULL AND ${holds}`)
        .bind(now, record.id, user.id),
      db
        .prepare(
          `UPDATE tenant_user SET email = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
           WHERE id = ? AND (username IS NOT NULL OR email_verified_at IS NOT NULL)
             AND EXISTS (SELECT 1 FROM tenant_user_email_verification WHERE id = ? AND used_at IS NOT NULL)`,
        )
        .bind(record.email, now, now, user.id, record.id),
    ],
    (err) => {
      const m = err instanceof Error ? err.message : "";
      if (m.includes("used_at is set once")) throw conflict("link_invalid", "This link is not valid or was already used");
      return mapDbError(err);
    },
  );
  if (results[0]!.meta.changes !== 1) {
    const again = await db.prepare("SELECT used_at FROM tenant_user_email_verification WHERE id = ?").bind(record.id).first<{ used_at: number | null }>();
    if (again?.used_at != null) throw conflict("link_invalid", "This link is not valid or was already used");
    throw new ApiError(403, "signup_abandoned", "This sign-up was abandoned, please sign up again");
  }
  return c.json({ verified: true });
});

// ------------------------------------------------------------------ /google-signup
signup.post("/google-signup", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `google-signup:${clientIp(c)}`, 20);

  failOnFields({ id_token: requiredString(body.id_token, "id_token is required") });
  const audiences = googleAudiences(c.env.GOOGLE_CLIENT_IDS ?? "");
  if (audiences.length === 0) throw conflict("google_not_configured", "Google sign-in is not available yet");
  const google = await deps.verifyGoogleToken(body.id_token as string, audiences);
  if (!google.emailVerified) throw new ApiError(403, "google_email_unverified", "Google did not confirm this email");

  const email = google.email.trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  let name = (google.name || local).trim().toLowerCase().slice(0, 100).trim();
  if (name === "") name = "user";
  const now = deps.now();

  const taken = await db
    .prepare("SELECT 1 AS x FROM tenant_user_login WHERE provider = 'google' AND provider_user_id = ?")
    .bind(google.sub)
    .first();
  if (taken) throw conflict("google_taken", "This Google account is already registered, please login instead");
  const existing = await getUserByEmail(db, email);
  if (existing && existing.email_verified_at !== null) {
    throw conflict("email_taken", "Email already registered, please login with your password and link Google from your profile");
  }

  const userId = existing?.id ?? newId();
  const loginInsert = (guard: string, ...guardBinds: unknown[]) =>
    db
      .prepare(
        `INSERT INTO tenant_user_login (id, created_at, provider, provider_user_id, user_id, password_hash, last_login_at, updated_at)
         SELECT ?, ?, 'google', ?, ?, NULL, NULL, ? WHERE ${guard}`,
      )
      .bind(newId(), now, google.sub, userId, now, ...guardBinds);
  const stmts = existing
    ? [
        db
          .prepare("UPDATE tenant_user SET email_verified_at = ?, username = NULL, name = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL")
          .bind(now, name, now, userId),
        // Google login first, then the password login goes, so the user is never left without a login.
        loginInsert("EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND email_verified_at = ?)", userId, now),
        db
          .prepare(
            "DELETE FROM tenant_user_login WHERE user_id = ? AND provider = 'password' AND EXISTS (SELECT 1 FROM tenant_user_login WHERE user_id = ? AND provider = 'google')",
          )
          .bind(userId, userId),
        closeLinksStmt(db, userId, now),
      ]
    : [
        db
          .prepare(
            "INSERT INTO tenant_user (id, created_at, email, email_verified_at, username, name, household_id, home_household_id, is_active, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 1, ?)",
          )
          .bind(userId, now, email, now, name, now),
        loginInsert("1 = 1"),
      ];
  await runBatch(db, stmts, mapDbError);
  return c.json({ user_id: userId, profile_needed: true }, 201);
});

// ------------------------------------------------------------------ /invite-signup
signup.post("/invite-signup", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `invite-signup:${clientIp(c)}`, 20);

  const username = clean(body.username);
  const name = clean(body.name);
  failOnFields({
    token: requiredString(body.token, "Token is required"),
    username: usernameError(username),
    name: nameError(name),
    password: passwordError(body.password),
  });
  const now = deps.now();
  const invite = await db
    .prepare("SELECT id, household_id, email, created_at FROM tenant_user_invite WHERE token_hash = ? AND status = 'open'")
    .bind(await hashToken(body.token as string))
    .first<{ id: string; household_id: string; email: string; created_at: number }>();
  if (!invite) throw conflict("invite_invalid", "This invite link is not valid");
  if (now > invite.created_at + DAY) throw conflict("invite_expired", "This invite has expired");

  const existing = await getUserByEmail(db, invite.email);
  if (existing && existing.email_verified_at !== null) {
    throw conflict("email_taken", "Email already registered, please login and accept the invite from your invites list");
  }
  const userId = existing?.id ?? newId();
  await assertUsernameFree(db, username!, userId, now);

  const passwordHash = await hashPassword(body.password as string);
  const open = "EXISTS (SELECT 1 FROM tenant_user_invite WHERE id = ? AND status = 'open')";
  const stillUnverified = "EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND email_verified_at IS NULL)";
  const loginInsert = (guard: string, ...guardBinds: unknown[]) =>
    db
      .prepare(
        `INSERT INTO tenant_user_login (id, created_at, provider, provider_user_id, user_id, password_hash, last_login_at, updated_at)
         SELECT ?, ?, 'password', ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM tenant_user_login WHERE user_id = ? AND provider = 'password') AND ${guard}`,
      )
      .bind(newId(), now, userId, userId, passwordHash, now, userId, ...guardBinds);

  const stmts = [
    releaseUsernameStmt(db, username!, userId, now),
    ...(existing
      ? [
          // Replace case: the login and the links change while the account is still unverified, then the account itself.
          db
            .prepare(`UPDATE tenant_user_login SET password_hash = ?, updated_at = ? WHERE user_id = ? AND provider = 'password' AND ${stillUnverified} AND ${open}`)
            .bind(passwordHash, now, userId, userId, invite.id),
          loginInsert(`${stillUnverified} AND ${open}`, userId, invite.id),
          closeLinksStmt(db, userId, now),
          db
            .prepare(`UPDATE tenant_user SET username = ?, name = ?, email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL AND ${open}`)
            .bind(username, name, now, now, userId, invite.id),
        ]
      : [
          db
            .prepare(
              `INSERT INTO tenant_user (id, created_at, email, email_verified_at, username, name, household_id, home_household_id, is_active, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ? WHERE ${open}`,
            )
            .bind(userId, now, invite.email, now, username, name, now, invite.id),
          loginInsert(open, invite.id),
        ]),
    db
      .prepare(
        `INSERT INTO tenant_household_member (household_id, user_id, created_at)
         SELECT ?, ?, ? WHERE ${open} AND EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND email_verified_at = ?)`,
      )
      .bind(invite.household_id, userId, now, invite.id, userId, now),
    db
      .prepare(
        `UPDATE tenant_user SET household_id = ?, home_household_id = ?, updated_at = ?
         WHERE id = ? AND household_id IS NULL AND ${open}`,
      )
      .bind(invite.household_id, invite.household_id, now, userId, invite.id),
    db
      .prepare("UPDATE tenant_user_invite SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'open'")
      .bind(now, invite.id),
  ];
  const lost = () => conflict("invite_invalid", "This invite link is not valid");
  const results = await runBatch(db, stmts, (err) => {
    const m = err instanceof Error ? err.message : "";
    // A second request with the same link ran into the first one's rows.
    if (m.includes("UNIQUE constraint failed: tenant_user.email")) throw lost();
    return mapDbError(err);
  });
  if (results[results.length - 1]!.meta.changes !== 1) throw lost();
  return c.json({ user_id: userId, household_id: invite.household_id }, 201);
});
