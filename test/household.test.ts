import { describe, expect, it } from "vitest";
import { row, rows, run } from "./helpers";
import { makeHarness } from "./flow";

const { h, api, newUser, newHouseholdUser, seedInvite, deps } = makeHarness();
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const uname = (n: string) => `${n}${crypto.randomUUID().slice(0, 6)}`;
const decode = (t: string) => JSON.parse(atob(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));

describe("/first-login-household", () => {
  it("creates household, member, owner, home, setting and the starter list; token carries the household", async () => {
    const u = await newUser(email("f"), uname("first"));
    const r = await api("/first-login-household", {}, { token: u.access });
    expect(r.status).toBe(200);
    const hid = r.json.household_id;
    const claims = decode(r.json.access_token);
    expect(claims).toMatchObject({ sub: u.id, hid, sid: decode(u.access).sid });
    expect(await row("SELECT household_id, home_household_id FROM tenant_user WHERE id = ?", u.id)).toEqual({ household_id: hid, home_household_id: hid });
    expect((await row("SELECT owner_id o FROM tenant_household WHERE id = ?", hid))!.o).toBe(u.id);
    expect(await row("SELECT 1 FROM tenant_household_member WHERE household_id = ? AND user_id = ?", hid, u.id)).not.toBeNull();
    expect(await row("SELECT * FROM app_household_setting WHERE household_id = ?", hid)).toMatchObject({
      cycle_start_day: 1, savings_target_amount: 0, savings_target_metrics: "net_balance", timezone: "Asia/Jakarta", updated_by: u.id,
    });
    const groups = await rows("SELECT name, type, created_by, icon FROM app_transaction_group WHERE household_id = ? ORDER BY name", hid);
    expect(groups.map((g) => g.name)).toEqual(["Fun", "Food", "Health", "Home", "Income", "Other", "Shopping", "Transport"].sort((a, b) => a.localeCompare(b)));
    expect(groups.find((g) => g.name === "Income")!.type).toBe("income");
    expect(groups.every((g) => g.created_by === u.id && g.icon === "⭕️")).toBe(true);
    expect((await row("SELECT COUNT(*) n FROM app_transaction_category WHERE household_id = ?", hid))!.n).toBe(21);
    const food = await rows("SELECT c.name FROM app_transaction_category c JOIN app_transaction_group g ON g.id = c.group_id WHERE g.household_id = ? AND g.name = 'Food' ORDER BY c.name", hid);
    expect(food.map((c) => c.name)).toEqual(["coffee", "eating out", "groceries"]);
    // A new login now says household_needed = false.
    expect((await api("/login", { identifier: u.email, password: u.password })).json.household_needed).toBe(false);
  });
  it("stores a known time zone as Intl resolves it, refuses an unknown one", async () => {
    const u = await newUser(email("z"), uname("zone"));
    const bad = await api("/first-login-household", { timezone: "Mars/Base" }, { token: u.access });
    expect([bad.status, bad.json.error.code, bad.json.error.fields]).toEqual([422, "validation_failed", { timezone: "Unknown time zone" }]);
    const ok = await api("/first-login-household", { timezone: "europe/amsterdam" }, { token: u.access });
    expect(ok.status).toBe(200);
    expect((await row("SELECT timezone t FROM app_household_setting WHERE household_id = ?", ok.json.household_id))!.t).toBe("Europe/Amsterdam");
  });
  it("household_already_set on a second call, profile_needed without a username", async () => {
    const u = await newHouseholdUser(email("s"), uname("second"));
    const r = await api("/first-login-household", {}, { token: u.access });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "household_already_set", "Household already set"]);

    const e = email("gp");
    h.google.set("gp", { sub: `sub-${e}`, email: e, emailVerified: true, name: "G" });
    await api("/google-signup", { id_token: "gp" });
    const token = (await api("/google-login", { id_token: "gp" })).json.access_token;
    const p = await api("/first-login-household", {}, { token });
    expect([p.status, p.json.error.code]).toEqual([409, "profile_needed"]);
  });
  it("two calls at the same moment make exactly one household", async () => {
    const u = await newUser(email("race"), uname("race"));
    const [a, b] = await Promise.all([api("/first-login-household", {}, { token: u.access }), api("/first-login-household", {}, { token: u.access })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error.code).toBe("household_already_set");
    expect((await row("SELECT COUNT(*) n FROM tenant_household_member WHERE user_id = ?", u.id))!.n).toBe(1);
    expect((await row("SELECT COUNT(*) n FROM app_transaction_group WHERE created_by = ?", u.id))!.n).toBe(8);
  });
  it("waiting invites: 409 invites_waiting with details, nothing saved; ignore_invites goes on; others stay open", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const u = await newUser(email("w"), uname("waiting"));
    const i1 = await seedInvite(owner.household, owner.id, u.email, deps.now() - 100);
    const i2 = await seedInvite((await newHouseholdUser(email("o2"), uname("owner2"))).household, (await row("SELECT id FROM tenant_user ORDER BY created_at DESC, rowid DESC LIMIT 1"))!.id, u.email, deps.now() - 50);
    const r = await api("/first-login-household", {}, { token: u.access });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "invites_waiting", "You have waiting invites"]);
    expect(r.json.error.details.invites.map((i: any) => i.invite_id)).toEqual([i2.id, i1.id]);
    expect(r.json.error.details.invites[1]).toEqual({ invite_id: i1.id, household_id: owner.household, invited_by_name: "alice test", created_at: expect.any(Number) });
    expect(r.json.error.fields).toBeUndefined();
    expect((await row("SELECT household_id h FROM tenant_user WHERE id = ?", u.id))!.h).toBeNull();
    expect((await api("/first-login-household", { ignore_invites: "yes" }, { token: u.access })).json.error.fields).toHaveProperty("ignore_invites");
    expect((await api("/first-login-household", { ignore_invites: true }, { token: u.access })).status).toBe(200);
    expect((await rows("SELECT status FROM tenant_user_invite WHERE id IN (?, ?)", i1.id, i2.id)).map((x) => x.status)).toEqual(["open", "open"]);
  });
  it("an expired invite does not block", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const u = await newUser(email("e"), uname("expinv"));
    await seedInvite(owner.household, owner.id, u.email, deps.now() - 90000);
    expect((await api("/first-login-household", {}, { token: u.access })).status).toBe(200);
  });
});

describe("/invites and /accept-invite", () => {
  it("lists open invites, newest first, not expired, not the current household", async () => {
    const o1 = await newHouseholdUser(email("o1"), uname("own1"));
    const o2 = await newHouseholdUser(email("o2"), uname("own2"));
    const u = await newHouseholdUser(email("u"), uname("user"));
    const mine = await seedInvite(u.household, u.id, u.email, deps.now()).catch(() => null);
    expect(mine).toBeNull(); // the DB refuses to invite a person already in that household
    const a = await seedInvite(o1.household, o1.id, u.email, deps.now() - 200);
    const b = await seedInvite(o2.household, o2.id, u.email, deps.now() - 100);
    await seedInvite(o1.household, o1.id, email("else"), deps.now());
    const r = await api("/invites", {}, { token: u.access });
    expect(r.status).toBe(200);
    expect(r.json.invites.map((i: any) => i.invite_id)).toEqual([b.id, a.id]);
    expect(r.json.invites[0]).toEqual({ invite_id: b.id, household_id: o2.household, invited_by_name: "alice test", created_at: expect.any(Number) });
    expect((await api("/invites", null, { token: u.access, raw: "" })).status).toBe(200);
  });
  it("a user without a household accepts: household becomes current and home, invite accepted, token carries it", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const u = await newUser(email("n"), uname("newbie"));
    const inv = await seedInvite(owner.household, owner.id, u.email);
    const r = await api("/accept-invite", { invite_id: inv.id }, { token: u.access });
    expect([r.status, r.json.household_id]).toEqual([200, owner.household]);
    expect(decode(r.json.access_token)).toMatchObject({ sub: u.id, hid: owner.household, sid: decode(u.access).sid });
    expect(await row("SELECT household_id, home_household_id FROM tenant_user WHERE id = ?", u.id)).toEqual({ household_id: owner.household, home_household_id: owner.household });
    expect((await row("SELECT status FROM tenant_user_invite WHERE id = ?", inv.id))!.status).toBe("accepted");
    expect((await row("SELECT owner_id o FROM tenant_household WHERE id = ?", owner.household))!.o).toBe(owner.id);
  });
  it("a user with a household moves; home stays; other open invites stay open; coming back adds no second member row", async () => {
    const o1 = await newHouseholdUser(email("o1"), uname("own1"));
    const o2 = await newHouseholdUser(email("o2"), uname("own2"));
    const u = await newHouseholdUser(email("u"), uname("mover"));
    const a = await seedInvite(o1.household, o1.id, u.email);
    const b = await seedInvite(o2.household, o2.id, u.email);
    expect((await api("/accept-invite", { invite_id: a.id }, { token: u.access })).status).toBe(200);
    expect(await row("SELECT household_id, home_household_id FROM tenant_user WHERE id = ?", u.id)).toEqual({ household_id: o1.household, home_household_id: u.household });
    expect((await row("SELECT status FROM tenant_user_invite WHERE id = ?", b.id))!.status).toBe("open");
    // Back to the home household by a new invite from its owner? The owner is the user; use o1 -> already member of o1 now, so accept o2 then o1 again.
    expect((await api("/accept-invite", { invite_id: b.id }, { token: u.access })).status).toBe(200);
    const again = await seedInvite(o1.household, o1.id, u.email);
    expect((await api("/accept-invite", { invite_id: again.id }, { token: u.access })).status).toBe(200);
    expect((await row("SELECT COUNT(*) n FROM tenant_household_member WHERE household_id = ? AND user_id = ?", o1.household, u.id))!.n).toBe(1);
  });
  it("refusals: profile_needed, invalid (unknown, other email, not open), expired, already in household", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const u = await newUser(email("r"), uname("refuse"));
    const other = await seedInvite(owner.household, owner.id, email("someone"));
    expect((await api("/accept-invite", { invite_id: other.id }, { token: u.access })).json.error).toMatchObject({ code: "invite_invalid", message: "This invite is not valid" });
    expect((await api("/accept-invite", { invite_id: crypto.randomUUID() }, { token: u.access })).json.error.code).toBe("invite_invalid");
    expect((await api("/accept-invite", {}, { token: u.access })).status).toBe(422);
    const old = await seedInvite(owner.household, owner.id, u.email, deps.now() - 90000);
    const exp = await api("/accept-invite", { invite_id: old.id }, { token: u.access });
    expect([exp.status, exp.json.error.code, exp.json.error.message]).toEqual([409, "invite_expired", "This invite has expired"]);
    await run("UPDATE tenant_user_invite SET status = 'cancelled' WHERE id = ?", old.id);

    // A Google user who has not chosen a username yet.
    const ge = email("gnp");
    h.google.set("gnp", { sub: `sub-${ge}`, email: ge, emailVerified: true, name: "G" });
    await api("/google-signup", { id_token: "gnp" });
    const gToken = (await api("/google-login", { id_token: "gnp" })).json.access_token;
    const gInvite = await seedInvite(owner.household, owner.id, ge);
    expect((await api("/accept-invite", { invite_id: gInvite.id }, { token: gToken })).json.error.code).toBe("profile_needed");

    const fresh = await seedInvite(owner.household, owner.id, u.email);
    expect((await api("/accept-invite", { invite_id: fresh.id }, { token: u.access })).status).toBe(200);
    const after = await seedInvite(owner.household, owner.id, u.email).catch(() => null);
    expect(after).toBeNull(); // DB: cannot invite someone already in the household
  });
  it("two accepts at the same moment: one wins, the other is invite_invalid", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const u = await newUser(email("race"), uname("race"));
    const inv = await seedInvite(owner.household, owner.id, u.email);
    const [a, b] = await Promise.all([api("/accept-invite", { invite_id: inv.id }, { token: u.access }), api("/accept-invite", { invite_id: inv.id }, { token: u.access })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.error.code).toMatch(/invite_invalid|already_in_household/);
    expect((await row("SELECT COUNT(*) n FROM tenant_household_member WHERE user_id = ? AND household_id = ?", u.id, owner.household))!.n).toBe(1);
  });
  it("already_in_household when the invite points at the current household", async () => {
    const o1 = await newHouseholdUser(email("o1"), uname("own1"));
    const u = await newUser(email("m"), uname("member"));
    const inv = await seedInvite(o1.household, o1.id, u.email);
    // The user joined the household by another way after the invite was sent.
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", o1.household, u.id);
    await run("UPDATE tenant_user SET household_id = ?, home_household_id = ? WHERE id = ?", o1.household, o1.household, u.id);
    await run("UPDATE tenant_user_invite SET status = 'open' WHERE id = ?", inv.id);
    const r = await api("/accept-invite", { invite_id: inv.id }, { token: u.access });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "already_in_household", "You are already in this household"]);
  });
});

describe("/me", () => {
  it("a new user: flags say profile done, household needed; password only", async () => {
    const u = await newUser(email("me"), uname("me"));
    const r = await api("/me", {}, { token: u.access });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      id: u.id, email: u.email, username: expect.any(String), name: "alice test", household_id: null, home_household_id: null, household_owner_name: null,
      profile_needed: false, household_needed: true, can_leave: false, has_password: true, has_google: false,
    });
  });
  it("a Google user without a profile: profile_needed, has_google only", async () => {
    const e = email("gme");
    h.google.set("gme", { sub: `sub-${e}`, email: e, emailVerified: true, name: "G" });
    await api("/google-signup", { id_token: "gme" });
    const token = (await api("/google-login", { id_token: "gme" })).json.access_token;
    expect((await api("/me", {}, { token })).json).toMatchObject({ username: null, profile_needed: true, has_password: false, has_google: true });
  });
  it("can_leave: false at home, true in another household as member, false there as owner; no body needed", async () => {
    const o1 = await newHouseholdUser(email("o1"), uname("own1"));
    const u = await newHouseholdUser(email("u"), uname("leaver"));
    expect((await api("/me", {}, { token: u.access })).json).toMatchObject({ household_id: u.household, household_needed: false, can_leave: false });
    const inv = await seedInvite(o1.household, o1.id, u.email);
    const moved = (await api("/accept-invite", { invite_id: inv.id }, { token: u.access })).json.access_token;
    const me = (await api("/me", null, { token: moved, raw: "" })).json;
    expect(me).toMatchObject({ household_id: o1.household, home_household_id: u.household, can_leave: true });
    expect(me.household_owner_name).toBe("alice test");
    await run("UPDATE tenant_user SET name = 'owner renamed' WHERE id = ?", o1.id);
    expect((await api("/me", {}, { token: moved })).json.household_owner_name).toBe("owner renamed");
    await run("UPDATE tenant_household SET owner_id = ? WHERE id = ?", u.id, o1.household);
    expect((await api("/me", {}, { token: moved })).json.can_leave).toBe(false);
  });
  it("needs a token", async () => {
    expect((await api("/me")).json.error.code).toBe("token_invalid");
  });
});
