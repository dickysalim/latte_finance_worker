import { Hono } from "hono";
import type { AppEnv } from "../lib/http";
import { clientIp, limit } from "../lib/http";
import { readBody } from "../lib/body";
import { ApiError, conflict, mapDbError } from "../lib/errors";
import { hashPassword, hashToken, newId, verifyPassword } from "../lib/crypto";
import { assertUsernameFree, getUserById, insertSessionStmt, releaseUsernameStmt, runBatch, type UserRow } from "../lib/accounts";
import { clean, failOnFields, nameError, passwordError, requiredString, usernameError } from "../lib/validate";
import { issueAccessToken, requireAuth } from "../lib/auth";

export const session = new Hono<AppEnv>();

const THIRTY_DAYS = 2592000;
const deactivated = () => new ApiError(403, "account_deactivated", "This account is deactivated");
const sessionEnded = () => new ApiError(401, "session_ended", "Please login again");

// A hash to compare against when the user does not exist, so a wrong identifier costs the same time as a wrong password.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword("not-a-real-password"));

// ------------------------------------------------------------------ /login
session.post("/login", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  failOnFields({
    identifier: requiredString(body.identifier, "Enter your email or username"),
    password: requiredString(body.password, "Enter your password"),
  });
  const identifier = clean(body.identifier)!;
  await limit(c, `login-id:${identifier}`, 5);
  await limit(c, `login-ip:${clientIp(c)}`, 20);

  const user = await db
    .prepare("SELECT * FROM tenant_user WHERE email = ? OR username = ?")
    .bind(identifier, identifier)
    .first<UserRow>();
  const login = user
    ? await db
        .prepare("SELECT password_hash FROM tenant_user_login WHERE user_id = ? AND provider = 'password'")
        .bind(user.id)
        .first<{ password_hash: string }>()
    : null;
  const passwordOk = await verifyPassword(body.password as string, login?.password_hash ?? (await getDummyHash()));
  if (!user || !login || !passwordOk) throw new ApiError(401, "invalid_credentials", "Wrong email, username or password");

  if (user.is_active === 0) throw deactivated();
  if (user.email_verified_at === null && user.username === null) {
    throw new ApiError(403, "signup_abandoned", "This sign-up was abandoned, please sign up again");
  }
  if (user.email_verified_at === null) throw new ApiError(403, "email_not_verified", "Please verify your email first");

  return c.json(await startSession(c, user, "UPDATE tenant_user_login SET last_login_at = ? WHERE user_id = ? AND provider = 'password'"));
});

/** One transaction: stamp the login, create the session. Replies with both tokens and the flags. */
async function startSession(c: Parameters<typeof issueAccessToken>[0], user: UserRow, loginStmt: string) {
  const deps = c.get("deps");
  const db = c.env.DB;
  const now = deps.now();
  const refresh = deps.randomToken();
  const sid = newId();
  await db.batch([db.prepare(loginStmt).bind(now, user.id), insertSessionStmt(db, sid, user.id, await hashToken(refresh), now)]);
  return {
    access_token: await issueAccessToken(c, { uid: user.id, hid: user.household_id, sid }),
    refresh_token: refresh,
    household_needed: user.household_id === null,
    profile_needed: user.username === null,
  };
}

// ------------------------------------------------------------------ /google-login
session.post("/google-login", async (c) => {
  const body = await readBody(c);
  const db = c.env.DB;
  await limit(c, `google-login:${clientIp(c)}`, 20);

  failOnFields({ id_token: requiredString(body.id_token, "id_token is required") });
  const audiences = (c.env.GOOGLE_CLIENT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (audiences.length === 0) throw conflict("google_not_configured", "Google sign-in is not available yet");
  const google = await c.get("deps").verifyGoogleToken(body.id_token as string, audiences);

  const login = await db
    .prepare("SELECT user_id FROM tenant_user_login WHERE provider = 'google' AND provider_user_id = ?")
    .bind(google.sub)
    .first<{ user_id: string }>();
  if (!login) throw new ApiError(404, "google_not_registered", "No account for this Google account, please sign up first");
  const user = (await getUserById(db, login.user_id))!;
  if (user.is_active === 0) throw deactivated();

  return c.json(await startSession(c, user, "UPDATE tenant_user_login SET last_login_at = ? WHERE user_id = ? AND provider = 'google'"));
});

// ------------------------------------------------------------------ /complete-profile
session.post("/complete-profile", requireAuth, async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  const { uid } = c.get("auth");

  const user = await getUserById(db, uid);
  if (!user) throw new ApiError(401, "token_invalid", "Please login again");
  if (user.username !== null) throw conflict("profile_completed", "Profile already completed");

  const username = clean(body.username);
  const name = clean(body.name);
  failOnFields({ username: usernameError(username), name: nameError(name), password: passwordError(body.password) });
  const now = deps.now();
  await assertUsernameFree(db, username!, uid, now);

  const passwordHash = await hashPassword(body.password as string);
  const results = await runBatch(
    db,
    [
      releaseUsernameStmt(db, username!, uid, now),
      db.prepare("UPDATE tenant_user SET username = ?, name = ?, updated_at = ? WHERE id = ? AND username IS NULL").bind(username, name, now, uid),
      db
        .prepare(
          `INSERT INTO tenant_user_login (id, created_at, provider, provider_user_id, user_id, password_hash, last_login_at, updated_at)
           SELECT ?, ?, 'password', ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND username = ?)`,
        )
        .bind(newId(), now, uid, uid, passwordHash, now, uid, username),
    ],
    mapDbError,
  );
  if (results[1]!.meta.changes !== 1) throw conflict("profile_completed", "Profile already completed");
  return c.json({ profile_needed: false });
});

// ------------------------------------------------------------------ /refresh
type SessionRow = {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  last_used_at: number;
  ended_at: number | null;
};

session.post("/refresh", async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  await limit(c, `refresh:${clientIp(c)}`, 20);
  failOnFields({ refresh_token: requiredString(body.refresh_token, "refresh_token is required") });

  const presented = await hashToken(body.refresh_token as string);
  const now = deps.now();
  const endSession = (id: string) =>
    db.prepare("UPDATE tenant_user_session SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(now, id).run();

  let row = await db.prepare("SELECT * FROM tenant_user_session WHERE refresh_token_hash = ?").bind(presented).first<SessionRow>();
  let previous = false;
  const byPrevious = () =>
    db.prepare("SELECT * FROM tenant_user_session WHERE previous_refresh_token_hash = ?").bind(presented).first<SessionRow>();
  if (!row) {
    row = await byPrevious();
    previous = true;
  }
  if (!row) throw sessionEnded();
  if (row.ended_at !== null) throw sessionEnded();
  if (now > row.last_used_at + THIRTY_DAYS) throw new ApiError(401, "session_expired", "Session expired, please login again");

  const user = (await getUserById(db, row.user_id))!;
  if (user.is_active === 0) {
    await endSession(row.id);
    throw new ApiError(401, "account_deactivated", "This account is deactivated");
  }

  const newRefresh = deps.randomToken();
  const newHash = await hashToken(newRefresh);
  /** Token renewed once already: renew again only inside the 60 second grace, keeping the grace start. */
  const graceRenewal = async (s: SessionRow) => {
    if (now - s.last_used_at > 60) {
      await endSession(s.id);
      throw sessionEnded();
    }
    const r = await db
      .prepare("UPDATE tenant_user_session SET refresh_token_hash = ? WHERE id = ? AND previous_refresh_token_hash = ? AND ended_at IS NULL")
      .bind(newHash, s.id, presented)
      .run();
    if (r.meta.changes !== 1) throw sessionEnded();
  };

  if (previous) {
    await graceRenewal(row);
  } else {
    const r = await db
      .prepare(
        "UPDATE tenant_user_session SET previous_refresh_token_hash = ?, refresh_token_hash = ?, last_used_at = ? WHERE id = ? AND refresh_token_hash = ? AND ended_at IS NULL",
      )
      .bind(presented, newHash, now, row.id, presented)
      .run();
    if (r.meta.changes !== 1) {
      // Another request renewed it at the same moment: treat the token as a previous one.
      const again = await byPrevious();
      if (!again) throw sessionEnded();
      await graceRenewal(again);
    }
  }
  const fresh = (await getUserById(db, row.user_id))!;
  return c.json({
    access_token: await issueAccessToken(c, { uid: fresh.id, hid: fresh.household_id, sid: row.id }),
    refresh_token: newRefresh,
  });
});

// ------------------------------------------------------------------ /logout, /logout-all
session.post("/logout", requireAuth, async (c) => {
  await readBody(c, true);
  const { sid } = c.get("auth");
  await c.env.DB.prepare("UPDATE tenant_user_session SET ended_at = ? WHERE id = ? AND ended_at IS NULL").bind(c.get("deps").now(), sid).run();
  return c.json({});
});

session.post("/logout-all", requireAuth, async (c) => {
  await readBody(c, true);
  const { uid } = c.get("auth");
  await c.env.DB.prepare("UPDATE tenant_user_session SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL").bind(c.get("deps").now(), uid).run();
  return c.json({});
});
