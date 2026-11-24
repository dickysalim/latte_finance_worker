import { describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto";
import { row, rows, run } from "./helpers";
import { makeHarness } from "./flow";

const { h, api, lastToken, newUser, newHouseholdUser, seedInvite, deps } = makeHarness();
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const uname = (n: string) => `${n}${crypto.randomUUID().slice(0, 6)}`;
const body = (over: object = {}) => ({ email: email("a"), username: uname("alice"), name: "Alice", password: "password123", ...over });

describe("request rules", () => {
  it("not JSON is 400, over 16 KB is 413", async () => {
    expect((await api("/normal-signup", null, { raw: "{nope" })).json.error.code).toBe("bad_request");
    const big = await api("/normal-signup", null, { raw: JSON.stringify({ x: "a".repeat(17000) }) });
    expect([big.status, big.json.error.code]).toEqual([413, "payload_too_large"]);
  });
  it("429 carries Retry-After and the contract text", async () => {
    h.limitsOn = true;
    h.counts.clear();
    let r;
    for (let i = 0; i < 6; i++) r = await api("/normal-signup", body(), { ip: "9.9.9.9" });
    h.limitsOn = false;
    expect([r!.status, r!.json.error.code, r!.headers.get("retry-after")]).toEqual([429, "rate_limited", "60"]);
    expect(r!.json.error.message).toBe("Too many attempts, please wait a minute");
  });
});

describe("/normal-signup", () => {
  it("creates user, password login and a verification record, sends one email, no household", async () => {
    const b = body();
    const before = h.sent.length;
    const r = await api("/normal-signup", b);
    expect([r.status, r.json]).toEqual([202, { message: "Check your email to continue" }]);
    const u = await row("SELECT * FROM tenant_user WHERE email = ?", b.email);
    expect(u).toMatchObject({ username: b.username, name: "alice", email_verified_at: null, household_id: null, is_active: 1 });
    expect(JSON.stringify(r.json)).not.toContain(u.id);
    const login = await row("SELECT * FROM tenant_user_login WHERE user_id = ?", u.id);
    expect(login).toMatchObject({ provider: "password", provider_user_id: u.id });
    expect(login.password_hash).toMatch(/^pbkdf2-sha256\$/);
    const v = await row("SELECT * FROM tenant_user_email_verification WHERE user_id = ?", u.id);
    expect(v.token_hash).toBe(await hashToken(lastToken(b.email)));
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent.at(-1)!.text).toContain("/verify?token=");
  });

  it("422 with one message per invalid field", async () => {
    const r = await api("/normal-signup", { email: "no-at", username: "a b", name: "", password: "short" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("validation_failed");
    expect(Object.keys(r.json.error.fields).sort()).toEqual(["email", "name", "password", "username"]);
    expect(r.json.error.fields.email).toBe("Enter a valid email");
    const wrongType = await api("/normal-signup", { email: 5, username: null });
    expect(Object.keys(wrongType.json.error.fields)).toContain("email");
  });

  it("cleans input: lowercase and trim", async () => {
    const e = email("Mixed");
    await api("/normal-signup", body({ email: `  ${e.toUpperCase()} `, username: `  ${uname("Bob")}`.toUpperCase(), name: "  Bob Smith " }));
    const u = await row("SELECT * FROM tenant_user WHERE email = ?", e);
    expect(u.name).toBe("bob smith");
    expect(u.username).toBe(u.username.toLowerCase());
  });

  it("a verified email gets the same reply, a notice email and no new rows", async () => {
    const alice = await newUser(email("v"), uname("verified"));
    const before = await row<{ n: number }>("SELECT COUNT(*) n FROM tenant_user");
    const sentBefore = h.sent.length;
    const r = await api("/normal-signup", body({ email: alice.email }));
    expect([r.status, r.json.message]).toEqual([202, "Check your email to continue"]);
    expect((await row<{ n: number }>("SELECT COUNT(*) n FROM tenant_user"))!.n).toBe(before!.n);
    expect(h.sent.length).toBe(sentBefore + 1);
    expect(h.sent.at(-1)!.text).toContain("Someone tried to sign up");
    expect(h.sent.at(-1)!.text).not.toContain("token=");
  });

  it("username taken: 409 username_taken, nothing saved", async () => {
    const alice = await newUser(email("t"), uname("taken"));
    const un = (await row("SELECT username FROM tenant_user WHERE id = ?", alice.id))!.username;
    const other = email("other");
    const r = await api("/normal-signup", body({ email: other, username: un.toUpperCase() }));
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "username_taken", "Username Exist, please use other username"]);
    expect(await row("SELECT 1 FROM tenant_user WHERE email = ?", other)).toBeNull();
  });

  it("username of an unverified account older than 24 hours is released", async () => {
    const old = body();
    await api("/normal-signup", old);
    const oldId = (await row("SELECT id FROM tenant_user WHERE email = ?", old.email))!.id;
    // Young: still held.
    expect((await api("/normal-signup", body({ username: old.username }))).json.error.code).toBe("username_taken");
    await run("UPDATE tenant_user SET created_at = created_at - 90000 WHERE id = ?", oldId);
    const fresh = body({ username: old.username });
    expect((await api("/normal-signup", fresh)).status).toBe(202);
    expect((await row("SELECT username FROM tenant_user WHERE id = ?", oldId))!.username).toBeNull();
    expect((await row("SELECT username FROM tenant_user WHERE email = ?", fresh.email))!.username).toBe(old.username);
  });

  it("an unverified account with the same email is replaced: same id, new password, old links closed", async () => {
    const b = body();
    await api("/normal-signup", b);
    const first = lastToken(b.email);
    const id = (await row("SELECT id FROM tenant_user WHERE email = ?", b.email))!.id;
    const oldHash = (await row("SELECT password_hash h FROM tenant_user_login WHERE user_id = ?", id))!.h;
    await api("/normal-signup", { ...b, username: uname("newname"), password: "another-pass-1" });
    expect((await rows("SELECT id FROM tenant_user WHERE email = ?", b.email)).length).toBe(1);
    expect((await row("SELECT id FROM tenant_user WHERE email = ?", b.email))!.id).toBe(id);
    expect((await row("SELECT password_hash h FROM tenant_user_login WHERE user_id = ?", id))!.h).not.toBe(oldHash);
    expect((await api("/email-verification", { token: first, password: "another-pass-1" })).json.error.code).toBe("link_invalid");
    expect((await api("/email-verification", { token: lastToken(b.email), password: "another-pass-1" })).status).toBe(200);
  });

  it("a failed email send does not undo the rows", async () => {
    h.failEmail = true;
    const b = body();
    const r = await api("/normal-signup", b);
    h.failEmail = false;
    expect(r.status).toBe(202);
    expect(await row("SELECT 1 FROM tenant_user WHERE email = ?", b.email)).not.toBeNull();
  });
});

describe("/email-verification", () => {
  it("verifies once; the second use and a wrong password are refused", async () => {
    const b = body();
    await api("/normal-signup", b);
    const token = lastToken(b.email);
    expect((await api("/email-verification", { token, password: "nope-nope-1" })).json.error).toMatchObject({ code: "wrong_password" });
    expect((await api("/email-verification", { token })).json.error.code).toBe("wrong_password");
    const ok = await api("/email-verification", { token, password: b.password });
    expect([ok.status, ok.json]).toEqual([200, { verified: true }]);
    expect((await row("SELECT email_verified_at v FROM tenant_user WHERE email = ?", b.email))!.v).toBeGreaterThan(0);
    const again = await api("/email-verification", { token, password: b.password });
    expect([again.status, again.json.error.code]).toEqual([409, "link_invalid"]);
    expect((await api("/email-verification", { token: "unknown" })).json.error.code).toBe("link_invalid");
  });

  it("expired link: 409 link_expired", async () => {
    const b = body();
    await api("/normal-signup", b);
    await run("UPDATE tenant_user_email_verification SET created_at = created_at - 90000 WHERE token_hash = ?", await hashToken(lastToken(b.email)));
    const r = await api("/email-verification", { token: lastToken(b.email), password: b.password });
    expect([r.status, r.json.error.code]).toEqual([409, "link_expired"]);
  });

  it("deactivated and abandoned accounts are refused", async () => {
    const d = body();
    await api("/normal-signup", d);
    await run("UPDATE tenant_user SET is_active = 0 WHERE email = ?", d.email);
    expect((await api("/email-verification", { token: lastToken(d.email), password: d.password })).json.error.code).toBe("account_deactivated");

    const a = body();
    await api("/normal-signup", a);
    await run("UPDATE tenant_user SET username = NULL WHERE email = ?", a.email);
    const r = await api("/email-verification", { token: lastToken(a.email), password: a.password });
    expect([r.status, r.json.error.code]).toEqual([403, "signup_abandoned"]);
    expect((await row("SELECT email_verified_at v FROM tenant_user WHERE email = ?", a.email))!.v).toBeNull();
  });

  it("an email change record: another user already has the email", async () => {
    const alice = await newUser(email("c"), uname("changer"));
    const bob = await newUser(email("d"), uname("holder"));
    await run("INSERT INTO tenant_user_email_verification (user_id, email, token_hash, created_at) VALUES (?, ?, ?, ?)", alice.id, bob.email, await hashToken("change-token"), deps.now());
    const r = await api("/email-verification", { token: "change-token", password: alice.password });
    expect([r.status, r.json.error.code]).toEqual([409, "email_taken"]);
  });

  it("an email change keeps email_verified_at and moves the email", async () => {
    const alice = await newUser(email("e"), uname("mover"));
    const before = (await row("SELECT email_verified_at v FROM tenant_user WHERE id = ?", alice.id))!.v;
    const next = email("new");
    await run("INSERT INTO tenant_user_email_verification (user_id, email, token_hash, created_at) VALUES (?, ?, ?, ?)", alice.id, next, await hashToken("move-token"), deps.now());
    expect((await api("/email-verification", { token: "move-token", password: alice.password })).status).toBe(200);
    expect(await row("SELECT email, email_verified_at v FROM tenant_user WHERE id = ?", alice.id)).toEqual({ email: next, v: before });
  });
});

describe("/email-verification-resend", () => {
  it("unknown identifier gets the same reply and no email", async () => {
    const n = h.sent.length;
    const r = await api("/email-verification-resend", { identifier: "nobody@example.com" });
    expect([r.status, r.json.message]).toEqual([200, "If an account needs verifying, we sent a new link"]);
    expect(h.sent.length).toBe(n);
  });
  it("sends a new link by email or username, closes the old one, waits 60 seconds", async () => {
    const b = body();
    await api("/normal-signup", b);
    const first = lastToken(b.email);
    await run("UPDATE tenant_user_email_verification SET created_at = created_at - 100 WHERE token_hash = ?", await hashToken(first));
    const n = h.sent.length;
    expect((await api("/email-verification-resend", { identifier: ` ${b.username.toUpperCase()} ` })).status).toBe(200);
    expect(h.sent.length).toBe(n + 1);
    const second = lastToken(b.email);
    expect(second).not.toBe(first);
    expect((await api("/email-verification", { token: first, password: b.password })).json.error.code).toBe("link_invalid");
    // Within 60 seconds nothing is sent.
    await api("/email-verification-resend", { identifier: b.email });
    expect(h.sent.length).toBe(n + 1);
    expect((await api("/email-verification", { token: second, password: b.password })).status).toBe(200);
  });
  it("a released username gets nothing", async () => {
    const b = body();
    await api("/normal-signup", b);
    await run("UPDATE tenant_user SET username = NULL WHERE email = ?", b.email);
    const n = h.sent.length;
    await api("/email-verification-resend", { identifier: b.email });
    expect(h.sent.length).toBe(n);
  });
});

describe("/invite-signup", () => {
  it("creates a verified user in the household, home household, invite accepted, no email", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const invitee = email("bob");
    const inv = await seedInvite(owner.household, owner.id, invitee);
    const sent = h.sent.length;
    const r = await api("/invite-signup", { token: inv.token, username: uname("bob"), name: "Bob", password: "password123" });
    expect([r.status, r.json.household_id]).toEqual([201, owner.household]);
    const u = await row("SELECT * FROM tenant_user WHERE email = ?", invitee);
    expect(u).toMatchObject({ household_id: owner.household, home_household_id: owner.household });
    expect(u.email_verified_at).toBeGreaterThan(0);
    expect(r.json.user_id).toBe(u.id);
    expect((await row("SELECT status FROM tenant_user_invite WHERE id = ?", inv.id))!.status).toBe("accepted");
    expect(await row("SELECT 1 FROM tenant_household_member WHERE household_id = ? AND user_id = ?", owner.household, u.id)).not.toBeNull();
    expect(h.sent.length).toBe(sent);
    expect((await api("/login", { identifier: invitee, password: "password123" })).json.household_needed).toBe(false);
  });
  it("same link twice: the second is invite_invalid", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const inv = await seedInvite(owner.household, owner.id, email("x"));
    const b = { token: inv.token, username: uname("x"), name: "X", password: "password123" };
    expect((await api("/invite-signup", b)).status).toBe(201);
    expect((await api("/invite-signup", { ...b, username: uname("y") })).json.error.code).toBe("invite_invalid");
  });
  it("unknown token, expired invite, verified email, taken username, bad fields", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const good = { username: uname("z"), name: "Z", password: "password123" };
    expect((await api("/invite-signup", { token: "nope", ...good })).json.error.code).toBe("invite_invalid");
    const old = await seedInvite(owner.household, owner.id, email("old"), Math.floor(Date.now() / 1000) - 90000);
    expect((await api("/invite-signup", { token: old.token, ...good })).json.error.code).toBe("invite_expired");
    const existing = await newUser(email("ex"), uname("existing"));
    const forVerified = await seedInvite(owner.household, owner.id, existing.email);
    expect((await api("/invite-signup", { token: forVerified.token, ...good })).json.error.code).toBe("email_taken");
    const t = await seedInvite(owner.household, owner.id, email("t"));
    const un = (await row("SELECT username FROM tenant_user WHERE id = ?", existing.id))!.username;
    expect((await api("/invite-signup", { token: t.token, ...good, username: un })).json.error.code).toBe("username_taken");
    const bad = await api("/invite-signup", { token: t.token, username: "a", name: "", password: "x" });
    expect(Object.keys(bad.json.error.fields).sort()).toEqual(["name", "password", "username"]);
  });
  it("replaces an unverified account that has the invite email", async () => {
    const owner = await newHouseholdUser(email("o"), uname("owner"));
    const pending = body();
    await api("/normal-signup", pending);
    const id = (await row("SELECT id FROM tenant_user WHERE email = ?", pending.email))!.id;
    const inv = await seedInvite(owner.household, owner.id, pending.email);
    const r = await api("/invite-signup", { token: inv.token, username: uname("neu"), name: "Neu", password: "password456" });
    expect([r.status, r.json.user_id]).toEqual([201, id]);
    expect((await api("/login", { identifier: pending.email, password: "password456" })).status).toBe(200);
    expect((await api("/email-verification", { token: lastToken(pending.email), password: "password456" })).json.error.code).toBe("link_invalid");
  });
});
