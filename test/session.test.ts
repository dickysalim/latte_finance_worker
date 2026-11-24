import { describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto";
import { signAccessToken } from "../src/lib/jwt";
import { row, rows, run } from "./helpers";
import { makeHarness } from "./flow";

const { h, api, lastToken, newUser, deps } = makeHarness();
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const uname = (n: string) => `${n}${crypto.randomUUID().slice(0, 6)}`;
const decode = (t: string) => JSON.parse(atob(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));

describe("access tokens", () => {
  it("no header, bad token, expired token", async () => {
    expect((await api("/logout")).json.error.code).toBe("token_invalid");
    expect((await api("/logout", {}, { token: "abc.def.ghi" })).json.error.code).toBe("token_invalid");
    const u = await newUser(email("t"), uname("tok"));
    const tampered = u.access.slice(0, -2) + (u.access.endsWith("AA") ? "BB" : "AA");
    expect((await api("/logout", {}, { token: tampered })).json.error.code).toBe("token_invalid");
    const expired = await signAccessToken("test-secret-not-real", { uid: u.id, hid: null, sid: "s" }, deps.now() - 1000);
    const r = await api("/logout", {}, { token: expired });
    expect([r.status, r.json.error.code]).toEqual([401, "token_expired"]);
    const wrongSecret = await signAccessToken("other-secret", { uid: u.id, hid: null, sid: "s" }, deps.now());
    expect((await api("/logout", {}, { token: wrongSecret })).json.error.code).toBe("token_invalid");
  });
  it("login token carries sub, hid null, sid and lives 900 seconds", async () => {
    const u = await newUser(email("c"), uname("claims"));
    const c = decode(u.access);
    expect(c).toMatchObject({ sub: u.id, hid: null });
    expect(c.exp - c.iat).toBe(900);
    expect((await row("SELECT 1 FROM tenant_user_session WHERE id = ?", c.sid))).not.toBeNull();
  });
});

describe("/login", () => {
  it("success: tokens, flags, last_login_at, session row with only the refresh hash", async () => {
    const u = await newUser(email("l"), uname("login"));
    const r = await api("/login", { identifier: ` ${u.email.toUpperCase()} `, password: u.password });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ household_needed: true, profile_needed: false });
    expect((await row("SELECT last_login_at l FROM tenant_user_login WHERE user_id = ?", u.id))!.l).toBeGreaterThan(0);
    const s = await row("SELECT * FROM tenant_user_session WHERE refresh_token_hash = ?", await hashToken(r.json.refresh_token));
    expect(s).toMatchObject({ user_id: u.id, previous_refresh_token_hash: null, ended_at: null });
    const byName = await api("/login", { identifier: (await row("SELECT username u FROM tenant_user WHERE id = ?", u.id))!.u, password: u.password });
    expect(byName.status).toBe(200);
  });
  it("wrong user and wrong password give the same 401", async () => {
    const u = await newUser(email("w"), uname("wrong"));
    const a = await api("/login", { identifier: u.email, password: "bad-password" });
    const b = await api("/login", { identifier: "ghost@example.com", password: "password123" });
    expect([a.status, a.json]).toEqual([401, b.json && { error: { code: "invalid_credentials", message: "Wrong email, username or password" } }]);
    expect(b.json).toEqual(a.json);
  });
  it("after the password: deactivated, abandoned, not verified", async () => {
    const pw = "password123";
    const mk = async (patch: string) => {
      const e = email("s");
      await api("/normal-signup", { email: e, username: uname("st"), name: "S", password: pw });
      if (patch) await run(`UPDATE tenant_user SET ${patch} WHERE email = ?`, e);
      return e;
    };
    expect((await api("/login", { identifier: await mk(""), password: pw })).json.error).toMatchObject({ code: "email_not_verified", message: "Please verify your email first" });
    expect((await api("/login", { identifier: await mk("username = NULL"), password: pw })).json.error.code).toBe("signup_abandoned");
    const d = await newUser(email("d"), uname("deact"));
    await run("UPDATE tenant_user SET is_active = 0 WHERE id = ?", d.id);
    const r = await api("/login", { identifier: d.email, password: d.password });
    expect([r.status, r.json.error.code]).toEqual([403, "account_deactivated"]);
    // The wrong password never reveals the account state.
    expect((await api("/login", { identifier: d.email, password: "bad-password" })).json.error.code).toBe("invalid_credentials");
  });
  it("429 after 5 tries for one identifier and after 20 from one IP", async () => {
    h.limitsOn = true;
    h.counts.clear();
    const same = [];
    for (let i = 0; i < 6; i++) same.push((await api("/login", { identifier: "x@example.com", password: "bad-password" }, { ip: "1.1.1.1" })).status);
    expect(same).toEqual([401, 401, 401, 401, 401, 429]);
    h.counts.clear();
    const ip = [];
    for (let i = 0; i < 21; i++) ip.push((await api("/login", { identifier: `u${i}@example.com`, password: "bad-password" }, { ip: "2.2.2.2" })).status);
    h.limitsOn = false;
    expect(ip[19]).toBe(401);
    expect(ip[20]).toBe(429);
  });
});

describe("/refresh, /logout, /logout-all", () => {
  it("renews: new refresh token, old one kept as previous, new access token", async () => {
    const u = await newUser(email("r"), uname("refresh"));
    const r = await api("/refresh", { refresh_token: u.refresh });
    expect(r.status).toBe(200);
    expect(r.json.refresh_token).not.toBe(u.refresh);
    expect(decode(r.json.access_token).sub).toBe(u.id);
    const s = await row("SELECT * FROM tenant_user_session WHERE user_id = ?", u.id);
    expect(s.previous_refresh_token_hash).toBe(await hashToken(u.refresh));
    expect(s.refresh_token_hash).toBe(await hashToken(r.json.refresh_token));
  });
  it("an old token inside 60 seconds renews again: previous = the replaced hash, last_used_at kept; at 60 seconds the session ends, other sessions stay", async () => {
    const u = await newUser(email("g"), uname("grace"));
    const second = await api("/login", { identifier: u.email, password: u.password });
    const t2 = (await api("/refresh", { refresh_token: u.refresh })).json.refresh_token; // T1 -> T2
    const before = await row("SELECT * FROM tenant_user_session WHERE refresh_token_hash = ?", await hashToken(t2));
    const t3 = await api("/refresh", { refresh_token: u.refresh }); // T1 again -> T3
    expect(t3.status).toBe(200);
    const s = await row("SELECT * FROM tenant_user_session WHERE id = ?", before.id);
    expect(s.refresh_token_hash).toBe(await hashToken(t3.json.refresh_token));
    expect(s.previous_refresh_token_hash).toBe(await hashToken(t2));
    expect(s.last_used_at).toBe(before.last_used_at); // the grace start does not move
    // T2 is now the previous token: it renews too (the app may have kept either reply).
    const t4 = await api("/refresh", { refresh_token: t2 });
    expect(t4.status).toBe(200);
    // T1 is two renewals old and unknown now.
    expect((await api("/refresh", { refresh_token: u.refresh })).json.error.code).toBe("session_ended");
    // Exactly 60 seconds after the first renewal the grace is over.
    await run("UPDATE tenant_user_session SET last_used_at = ? WHERE id = ?", deps.now() - 60, s.id);
    const late = await api("/refresh", { refresh_token: t3.json.refresh_token });
    expect([late.status, late.json.error.code]).toEqual([401, "session_ended"]);
    expect((await row("SELECT ended_at e FROM tenant_user_session WHERE id = ?", s.id))!.e).toBeGreaterThan(0);
    expect((await api("/refresh", { refresh_token: second.json.refresh_token })).status).toBe(200);
  });
  it("59 seconds after the renewal the grace still works", async () => {
    const u = await newUser(email("g59"), uname("grace59"));
    await api("/refresh", { refresh_token: u.refresh });
    await run("UPDATE tenant_user_session SET last_used_at = ? WHERE user_id = ?", deps.now() - 59, u.id);
    expect((await api("/refresh", { refresh_token: u.refresh })).status).toBe(200);
  });
  it("two parallel requests with the same old token both get a working reply", async () => {
    const u = await newUser(email("par"), uname("parallel"));
    await api("/refresh", { refresh_token: u.refresh });
    const [a, b] = await Promise.all([api("/refresh", { refresh_token: u.refresh }), api("/refresh", { refresh_token: u.refresh })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Whichever token the app keeps, it still renews inside the grace.
    expect((await api("/refresh", { refresh_token: a.json.refresh_token })).status).toBe(200);
  });
  it("unknown token, ended session, 30 days idle, deactivated user", async () => {
    expect((await api("/refresh", { refresh_token: "unknown" })).json.error.code).toBe("session_ended");
    const u = await newUser(email("x"), uname("expire"));
    h.offset = 2592001;
    const r = await api("/refresh", { refresh_token: u.refresh });
    h.offset = 0;
    expect([r.status, r.json.error.code]).toEqual([401, "session_expired"]);
    const d = await newUser(email("y"), uname("deact"));
    await run("UPDATE tenant_user SET is_active = 0 WHERE id = ?", d.id);
    const dr = await api("/refresh", { refresh_token: d.refresh });
    expect([dr.status, dr.json.error.code]).toEqual([403, "account_deactivated"]);
    expect((await api("/refresh", { refresh_token: d.refresh })).json.error.code).toBe("session_ended");
  });
  it("logout ends the session, the refresh token stops working, other sessions stay", async () => {
    const u = await newUser(email("o"), uname("logout"));
    const other = await api("/login", { identifier: u.email, password: u.password });
    expect((await api("/logout", {}, { token: u.access })).status).toBe(200);
    expect((await api("/refresh", { refresh_token: u.refresh })).json.error.code).toBe("session_ended");
    expect((await api("/refresh", { refresh_token: other.json.refresh_token })).status).toBe(200);
    // Ending twice is fine and keeps the first time.
    expect((await api("/logout", {}, { token: u.access })).status).toBe(200);
  });
  it("logout-all ends every session of the user", async () => {
    const u = await newUser(email("a"), uname("all"));
    const other = await api("/login", { identifier: u.email, password: u.password });
    expect((await api("/logout-all", {}, { token: u.access })).status).toBe(200);
    expect((await api("/refresh", { refresh_token: u.refresh })).json.error.code).toBe("session_ended");
    expect((await api("/refresh", { refresh_token: other.json.refresh_token })).json.error.code).toBe("session_ended");
    expect((await rows("SELECT 1 FROM tenant_user_session WHERE user_id = ? AND ended_at IS NULL", u.id)).length).toBe(0);
  });
});

describe("Google", () => {
  const g = (sub: string, over: object = {}) => ({ sub, email: email("g"), emailVerified: true, name: "Gina Google", ...over });
  const signup = (token: string) => api("/google-signup", { id_token: token });

  it("answers 409 google_not_configured while no client id is set", async () => {
    h.clientIds = "";
    const a = await signup("t");
    const b = await api("/google-login", { id_token: "t" });
    h.clientIds = "test-client-id";
    expect([a.status, a.json.error.code, b.status, b.json.error.code]).toEqual([409, "google_not_configured", 409, "google_not_configured"]);
  });
  it("invalid token 401, unverified email 403", async () => {
    expect((await signup("nope")).json.error).toMatchObject({ code: "google_token_invalid", message: "Google token is not valid" });
    h.google.set("unv", g("sub-unv", { emailVerified: false }));
    expect([(await signup("unv")).status, (await signup("unv")).json.error.code]).toEqual([403, "google_email_unverified"]);
    expect((await api("/google-signup", {})).status).toBe(422);
  });
  it("signs up without sending email, then logs in with profile_needed", async () => {
    const p = g("sub-1", { name: "  Gina GOOGLE " });
    h.google.set("t1", p);
    const n = h.sent.length;
    const r = await signup("t1");
    expect([r.status, r.json.profile_needed]).toEqual([201, true]);
    const u = await row("SELECT * FROM tenant_user WHERE email = ?", p.email);
    expect(u).toMatchObject({ username: null, name: "gina google", household_id: null });
    expect(u.email_verified_at).toBeGreaterThan(0);
    expect(r.json.user_id).toBe(u.id);
    expect(h.sent.length).toBe(n);
    const login = await row("SELECT * FROM tenant_user_login WHERE user_id = ?", u.id);
    expect(login).toMatchObject({ provider: "google", provider_user_id: "sub-1", password_hash: null });
    const li = await api("/google-login", { id_token: "t1" });
    expect(li.json).toMatchObject({ profile_needed: true, household_needed: true });
    expect((await row("SELECT last_login_at l FROM tenant_user_login WHERE user_id = ?", u.id))!.l).toBeGreaterThan(0);
  });
  it("uses the part before @ when Google sends no name, and 'user' as the last resort", async () => {
    h.google.set("n1", g("sub-n1", { name: "", email: "jane.roe@example.com" }));
    await signup("n1");
    expect((await row("SELECT name FROM tenant_user WHERE email = 'jane.roe@example.com'"))!.name).toBe("jane.roe");
  });
  it("same Google id again: google_taken; verified email: email_taken", async () => {
    h.google.set("t2", g("sub-2"));
    await signup("t2");
    expect([(await signup("t2")).status, (await signup("t2")).json.error.code]).toEqual([409, "google_taken"]);
    const v = await newUser(email("v"), uname("verified"));
    h.google.set("t3", g("sub-3", { email: v.email }));
    expect((await signup("t3")).json.error.code).toBe("email_taken");
  });
  it("takes over an unverified account: same id, Google login added, password login removed, links closed", async () => {
    const e = email("tk");
    await api("/normal-signup", { email: e, username: uname("squat"), name: "Squatter", password: "password123" });
    const id = (await row("SELECT id FROM tenant_user WHERE email = ?", e))!.id;
    h.google.set("t4", g("sub-4", { email: e }));
    const r = await signup("t4");
    expect([r.status, r.json.user_id]).toEqual([201, id]);
    expect(await row("SELECT username, email_verified_at v, name FROM tenant_user WHERE id = ?", id)).toMatchObject({ username: null, name: "gina google" });
    expect((await rows("SELECT provider FROM tenant_user_login WHERE user_id = ?", id)).map((x) => x.provider)).toEqual(["google"]);
    expect((await api("/email-verification", { token: lastToken(e) })).json.error.code).toBe("link_invalid");
    expect((await api("/login", { identifier: e, password: "password123" })).json.error.code).toBe("invalid_credentials");
  });
  it("google-login: unknown account 404, deactivated 403", async () => {
    h.google.set("u1", g("sub-unknown"));
    const r = await api("/google-login", { id_token: "u1" });
    expect([r.status, r.json.error.code]).toEqual([404, "google_not_registered"]);
    h.google.set("t5", g("sub-5"));
    await signup("t5");
    await run("UPDATE tenant_user SET is_active = 0 WHERE email = ?", h.google.get("t5")!.email);
    expect((await api("/google-login", { id_token: "t5" })).json.error.code).toBe("account_deactivated");
  });
  it("/complete-profile sets username, name and a password login; a second call is refused", async () => {
    const p = g("sub-6");
    h.google.set("t6", p);
    await signup("t6");
    const li = await api("/google-login", { id_token: "t6" });
    const token = li.json.access_token;
    const bad = await api("/complete-profile", { username: "a", name: "", password: "x" }, { token });
    expect(Object.keys(bad.json.error.fields).sort()).toEqual(["name", "password", "username"]);
    const un = uname("gina");
    expect((await api("/complete-profile", { username: ` ${un.toUpperCase()}`, name: " Gina G ", password: "password123" }, { token })).status).toBe(200);
    const u = await row("SELECT * FROM tenant_user WHERE email = ?", p.email);
    expect(u).toMatchObject({ username: un, name: "gina g" });
    expect((await rows("SELECT provider FROM tenant_user_login WHERE user_id = ? ORDER BY provider", u.id)).map((x) => x.provider)).toEqual(["google", "password"]);
    expect((await row("SELECT provider_user_id p FROM tenant_user_login WHERE user_id = ? AND provider = 'google'", u.id))!.p).toBe("sub-6");
    const again = await api("/complete-profile", { username: uname("zz"), name: "Z", password: "password123" }, { token });
    expect([again.status, again.json.error.code]).toEqual([409, "profile_completed"]);
    expect((await api("/login", { identifier: p.email, password: "password123" })).json.profile_needed).toBe(false);
  });
  it("/complete-profile: taken username 409; an old unverified holder releases it", async () => {
    const holder = body();
    await api("/normal-signup", holder);
    h.google.set("t7", g("sub-7"));
    await signup("t7");
    const token = (await api("/google-login", { id_token: "t7" })).json.access_token;
    const attempt = { username: holder.username, name: "G", password: "password123" };
    expect((await api("/complete-profile", attempt, { token })).json.error.code).toBe("username_taken");
    await run("UPDATE tenant_user SET created_at = created_at - 90000 WHERE email = ?", holder.email);
    expect((await api("/complete-profile", attempt, { token })).status).toBe(200);
    expect((await row("SELECT username FROM tenant_user WHERE email = ?", holder.email))!.username).toBeNull();
  });
});
const body = () => ({ email: email("h"), username: uname("holder"), name: "H", password: "password123" });
