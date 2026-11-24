import { Hono } from "hono";
import type { AppEnv } from "../lib/http";
import { readBody } from "../lib/body";
import { conflict, invalid, mapDbError } from "../lib/errors";
import { newId } from "../lib/crypto";
import { DAY, getUserById, runBatch } from "../lib/accounts";
import { failOnFields, requiredString } from "../lib/validate";
import { issueAccessToken, requireAuth } from "../lib/auth";
import { STARTER_GROUPS } from "../lib/starter";

export const household = new Hono<AppEnv>();

const DEFAULT_TIMEZONE = "Asia/Jakarta";

type InviteRow = { invite_id: string; household_id: string; invited_by_name: string; created_at: number };

const invitesFor = (db: D1Database, email: string, currentHousehold: string | null, now: number) =>
  db
    .prepare(
      `SELECT i.id AS invite_id, i.household_id, u.name AS invited_by_name, i.created_at
       FROM tenant_user_invite i JOIN tenant_user u ON u.id = i.invited_by
       WHERE i.email = ? AND i.status = 'open' AND i.created_at + 86400 >= ? AND i.household_id IS NOT ?
       ORDER BY i.created_at DESC, i.id`,
    )
    .bind(email, now, currentHousehold)
    .all<InviteRow>()
    .then((r) => r.results);

/** The name Intl resolves, or null when the worker does not know the time zone. */
function resolveTimezone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ /first-login-household
household.post("/first-login-household", requireAuth, async (c) => {
  const body = await readBody(c, true);
  const deps = c.get("deps");
  const db = c.env.DB;
  const { uid, sid } = c.get("auth");

  const fields: Record<string, string | null> = { ignore_invites: null, timezone: null };
  if (body.ignore_invites !== undefined && typeof body.ignore_invites !== "boolean") fields.ignore_invites = "Send true or false";
  if (body.timezone !== undefined && typeof body.timezone !== "string") fields.timezone = "Unknown time zone";
  failOnFields(fields);

  const user = (await getUserById(db, uid))!;
  if (user.household_id !== null) throw conflict("household_already_set", "Household already set");
  if (user.username === null) throw conflict("profile_needed", "Please complete your profile first");

  let timezone = DEFAULT_TIMEZONE;
  if (body.timezone !== undefined) {
    const resolved = resolveTimezone(body.timezone as string);
    if (!resolved) throw invalid({ timezone: "Unknown time zone" });
    timezone = resolved;
  }
  const now = deps.now();
  const waiting = await invitesFor(db, user.email, null, now);
  if (waiting.length > 0 && body.ignore_invites !== true) {
    throw conflict("invites_waiting", "You have waiting invites", { invites: waiting });
  }

  const hid = newId();
  // Every statement carries the guard, so a second tab that runs later saves nothing.
  const before = "EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND (household_id IS NULL OR household_id = ?))";
  const after = "EXISTS (SELECT 1 FROM tenant_user WHERE id = ? AND household_id = ?)";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO tenant_household (id, created_at, updated_at, owner_id) SELECT ?, ?, ?, NULL WHERE ${before}`)
      .bind(hid, now, now, uid, hid),
    db
      .prepare(`INSERT INTO tenant_household_member (household_id, user_id, created_at) SELECT ?, ?, ? WHERE ${before}`)
      .bind(hid, uid, now, uid, hid),
    db
      .prepare("UPDATE tenant_user SET household_id = ?, home_household_id = ?, updated_at = ? WHERE id = ? AND household_id IS NULL")
      .bind(hid, hid, now, uid),
    db.prepare(`UPDATE tenant_household SET owner_id = ? WHERE id = ? AND owner_id IS NULL AND ${after}`).bind(uid, hid, uid, hid),
    db
      .prepare(
        `INSERT INTO app_household_setting (household_id, cycle_start_day, savings_target_amount, updated_at, updated_by, savings_target_metrics, timezone)
         SELECT ?, 1, 0, ?, ?, 'net_balance', ? WHERE ${after}`,
      )
      .bind(hid, now, uid, timezone, uid, hid),
  ];
  for (const g of STARTER_GROUPS) {
    const gid = newId();
    stmts.push(
      db
        .prepare(
          `INSERT INTO app_transaction_group (id, created_at, created_by, household_id, is_active, updated_at, updated_by, name, type)
           SELECT ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE ${after}`,
        )
        .bind(gid, now, uid, hid, now, uid, g.name, g.type, uid, hid),
    );
    for (const cat of g.categories) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO app_transaction_category (id, created_at, created_by, household_id, is_active, updated_at, updated_by, group_id, name)
             SELECT ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE ${after}`,
          )
          .bind(newId(), now, uid, hid, now, uid, gid, cat, uid, hid),
      );
    }
  }
  await runBatch(db, stmts, mapDbError);

  const after2 = (await getUserById(db, uid))!;
  if (after2.household_id !== hid) throw conflict("household_already_set", "Household already set");
  return c.json({ access_token: await issueAccessToken(c, { uid, hid, sid }), household_id: hid });
});

// ------------------------------------------------------------------ /invites
household.post("/invites", requireAuth, async (c) => {
  await readBody(c, true);
  const db = c.env.DB;
  const user = (await getUserById(db, c.get("auth").uid))!;
  return c.json({ invites: await invitesFor(db, user.email, user.household_id, c.get("deps").now()) });
});

// ------------------------------------------------------------------ /accept-invite
household.post("/accept-invite", requireAuth, async (c) => {
  const body = await readBody(c);
  const deps = c.get("deps");
  const db = c.env.DB;
  const { uid, sid } = c.get("auth");
  failOnFields({ invite_id: requiredString(body.invite_id, "invite_id is required") });

  const user = (await getUserById(db, uid))!;
  if (user.username === null) throw conflict("profile_needed", "Please complete your profile first");
  const invite = await db
    .prepare("SELECT id, household_id, created_at FROM tenant_user_invite WHERE id = ? AND email = ? AND status = 'open'")
    .bind(body.invite_id, user.email)
    .first<{ id: string; household_id: string; created_at: number }>();
  if (!invite) throw conflict("invite_invalid", "This invite is not valid");
  const now = deps.now();
  if (now > invite.created_at + DAY) throw conflict("invite_expired", "This invite has expired");
  if (invite.household_id === user.household_id) throw conflict("already_in_household", "You are already in this household");

  const open = "EXISTS (SELECT 1 FROM tenant_user_invite WHERE id = ? AND status = 'open')";
  const results = await runBatch(
    db,
    [
      db
        .prepare(
          `INSERT INTO tenant_household_member (household_id, user_id, created_at)
           SELECT ?, ?, ? WHERE ${open} AND NOT EXISTS (SELECT 1 FROM tenant_household_member WHERE household_id = ? AND user_id = ?)`,
        )
        .bind(invite.household_id, uid, now, invite.id, invite.household_id, uid),
      db
        .prepare(`UPDATE tenant_user SET household_id = ?, updated_at = ? WHERE id = ? AND ${open}`)
        .bind(invite.household_id, now, uid, invite.id),
      db
        .prepare(`UPDATE tenant_user SET home_household_id = ? WHERE id = ? AND home_household_id IS NULL AND household_id = ? AND ${open}`)
        .bind(invite.household_id, uid, invite.household_id, invite.id),
      db
        .prepare("UPDATE tenant_user_invite SET status = 'accepted', updated_at = ? WHERE id = ? AND status = 'open'")
        .bind(now, invite.id),
    ],
    mapDbError,
  );
  const readBack = (await getUserById(db, uid))!;
  if (results[3]!.meta.changes !== 1 || readBack.household_id !== invite.household_id) {
    throw conflict("invite_invalid", "This invite is not valid");
  }
  return c.json({ access_token: await issueAccessToken(c, { uid, hid: invite.household_id, sid }), household_id: invite.household_id });
});

// ------------------------------------------------------------------ /me
household.post("/me", requireAuth, async (c) => {
  await readBody(c, true);
  const db = c.env.DB;
  const user = (await getUserById(db, c.get("auth").uid))!;
  const logins = await db
    .prepare("SELECT provider FROM tenant_user_login WHERE user_id = ?")
    .bind(user.id)
    .all<{ provider: string }>()
    .then((r) => r.results.map((l) => l.provider));
  const owner =
    user.household_id === null
      ? null
      : (await db.prepare("SELECT owner_id FROM tenant_household WHERE id = ?").bind(user.household_id).first<{ owner_id: string | null }>())?.owner_id;
  return c.json({
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    household_id: user.household_id,
    home_household_id: user.home_household_id,
    profile_needed: user.username === null,
    household_needed: user.household_id === null,
    can_leave: user.household_id !== null && user.household_id !== user.home_household_id && owner !== user.id,
    has_password: logins.includes("password"),
    has_google: logins.includes("google"),
  });
});
