import { describe, expect, it } from "vitest";
import { joinHousehold, nextN, rejects, row, run, seedHousehold, seedUser, uid } from "./helpers";

const insUser = (over: Record<string, unknown> = {}) => {
  const i = nextN();
  const v = { id: uid(), email: `carol${i}@example.com`, username: `carol${i}`, name: "carol", ...over };
  return run("INSERT INTO tenant_user (id, email, username, name) VALUES (?, ?, ?, ?)", v.id, v.email, v.username, v.name);
};

describe("tenant_user CHECKs and UNIQUEs", () => {
  it("valid insert passes", async () => {
    await insUser();
  });
  it("email must be lowercase and trimmed", async () => {
    await rejects(insUser({ email: "Carol@example.com" }), /CHECK/);
    await rejects(insUser({ email: " carol@example.com" }), /CHECK/);
  });
  it("email needs @ and at most 254 chars", async () => {
    await rejects(insUser({ email: "carol.example.com" }), /CHECK/);
    await rejects(insUser({ email: "a".repeat(250) + "@x.co" }), /CHECK/);
  });
  it("email is unique, case-insensitively", async () => {
    const { email } = await seedUser();
    await rejects(insUser({ email }), /UNIQUE/);
  });
  it("username: lowercase, 3-30 chars, no space, no @, unique", async () => {
    await rejects(insUser({ username: "Carol" }), /CHECK/);
    await rejects(insUser({ username: "ab" }), /CHECK/);
    await rejects(insUser({ username: "a".repeat(31) }), /CHECK/);
    await rejects(insUser({ username: "car ol" }), /CHECK/);
    await rejects(insUser({ username: "car@ol" }), /CHECK/);
    const { id } = await seedUser({ username: "taken" });
    expect(id).toBeTruthy();
    await rejects(insUser({ username: "taken" }), /UNIQUE/);
  });
  it("username may be NULL (several rows)", async () => {
    await insUser({ username: null });
    await insUser({ username: null });
  });
  it("name: lowercase, not empty, at most 100", async () => {
    await rejects(insUser({ name: "Carol" }), /CHECK/);
    await rejects(insUser({ name: "" }), /CHECK/);
    await rejects(insUser({ name: "a".repeat(101) }), /CHECK/);
  });
  it("email_verified_at must be > 0", async () => {
    await rejects(run("INSERT INTO tenant_user (email, name, email_verified_at) VALUES ('z@example.com', 'z', 0)"), /CHECK/);
  });
  it("is_active only 0 / 1; created_at > 0", async () => {
    await rejects(run("INSERT INTO tenant_user (email, name, is_active) VALUES ('y@example.com', 'y', 2)"), /CHECK/);
    await rejects(run("INSERT INTO tenant_user (email, name, created_at) VALUES ('x@example.com', 'x', 0)"), /CHECK/);
  });
});

describe("tenant_user triggers", () => {
  it("email_verified_at: set once from NULL, then frozen", async () => {
    const u = await insUser();
    void u;
    const { id } = await seedUser();
    await rejects(run("UPDATE tenant_user SET email_verified_at = email_verified_at + 5 WHERE id = ?", id), /set once/);
    await rejects(run("UPDATE tenant_user SET email_verified_at = NULL WHERE id = ?", id), /set once/);
    const un = uid();
    await run("INSERT INTO tenant_user (id, email, name) VALUES (?, 'unv@example.com', 'unv')", un);
    await run("UPDATE tenant_user SET email_verified_at = 100 WHERE id = ?", un);
  });
  it("username: back to NULL refused once verified, allowed while unverified", async () => {
    const { id } = await seedUser();
    await rejects(run("UPDATE tenant_user SET username = NULL WHERE id = ?", id), /username/);
    const un = uid();
    await run("INSERT INTO tenant_user (id, email, username, name) VALUES (?, 'unv2@example.com', 'unvname', 'unv')", un);
    await run("UPDATE tenant_user SET username = NULL WHERE id = ?", un);
  });
  it("household_id: needs a member row (FK), never back to NULL, may move to another household of the user", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await rejects(run("UPDATE tenant_user SET household_id = ? WHERE id = ?", b.hh, a.owner), /FOREIGN KEY/);
    await rejects(run("UPDATE tenant_user SET household_id = NULL WHERE id = ?", a.owner), /NULL/);
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, a.owner);
    await run("UPDATE tenant_user SET household_id = ? WHERE id = ?", b.hh, a.owner);
  });
  it("home_household_id: set once; later changes only together with household_id", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, a.owner);
    await rejects(run("UPDATE tenant_user SET home_household_id = ? WHERE id = ?", b.hh, a.owner), /home_household_id/);
    await rejects(run("UPDATE tenant_user SET home_household_id = NULL WHERE id = ?", a.owner), /home_household_id/);
    await rejects(run("UPDATE tenant_user SET household_id = ?, home_household_id = ? WHERE id = ?", a.hh, b.hh, a.owner), /home_household_id/);
    await run("UPDATE tenant_user SET household_id = ?, home_household_id = ? WHERE id = ?", b.hh, b.hh, a.owner);
  });
  it("home_household_id: first set from NULL needs a member row", async () => {
    const a = await seedHousehold();
    const u = await seedUser();
    await rejects(run("UPDATE tenant_user SET home_household_id = ? WHERE id = ?", a.hh, u.id), /FOREIGN KEY/);
    await joinHousehold(u.id, a.hh);
    await run("UPDATE tenant_user SET home_household_id = ? WHERE id = ?", a.hh, u.id);
  });
  it("is_active: 1 to 0 only", async () => {
    const { id } = await seedUser();
    await run("UPDATE tenant_user SET is_active = 0 WHERE id = ?", id);
    await rejects(run("UPDATE tenant_user SET is_active = 1 WHERE id = ?", id), /never goes back/);
  });
});

describe("tenant_household", () => {
  it("owner_id must be a member of this household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await rejects(run("UPDATE tenant_household SET owner_id = ? WHERE id = ?", b.owner, a.hh), /FOREIGN KEY/);
  });
  it("owner_id may be NULL at first", async () => {
    await run("INSERT INTO tenant_household (id) VALUES (?)", uid());
  });
  it("created_at / updated_at must be > 0", async () => {
    await rejects(run("INSERT INTO tenant_household (id, created_at) VALUES (?, 0)", uid()), /CHECK/);
  });
});

describe("tenant_household_member", () => {
  it("rows are never updated or deleted", async () => {
    const a = await seedHousehold();
    await rejects(run("UPDATE tenant_household_member SET created_at = 5 WHERE user_id = ?", a.owner), /never updated/);
    await rejects(run("DELETE FROM tenant_household_member WHERE user_id = ?", a.owner), /never deleted/);
  });
  it("same (household, user) pair twice is refused", async () => {
    const a = await seedHousehold();
    await rejects(run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", a.hh, a.owner), /UNIQUE|PRIMARY/);
  });
  it("household and user must exist", async () => {
    const a = await seedHousehold();
    await rejects(run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", uid(), a.owner), /FOREIGN KEY/);
  });
});

describe("tenant_user_login", () => {
  const insLogin = (userId: string, over: Record<string, unknown> = {}) => {
    const v = { provider: "google", provider_user_id: `sub-${nextN()}`, password_hash: null, ...over };
    return run("INSERT INTO tenant_user_login (user_id, provider, provider_user_id, password_hash) VALUES (?, ?, ?, ?)", userId, v.provider, v.provider_user_id, v.password_hash);
  };
  it("google login without hash passes; password login with hash and own id passes", async () => {
    const u = await seedUser();
    await insLogin(u.id);
    await insLogin(u.id, { provider: "password", provider_user_id: u.id, password_hash: "pbkdf2-sha256$100000$s$h" });
  });
  it("provider must be password / google / apple", async () => {
    const u = await seedUser();
    await rejects(insLogin(u.id, { provider: "github" }), /CHECK/);
  });
  it("password needs a hash; others must not have one", async () => {
    const u = await seedUser();
    await rejects(insLogin(u.id, { provider: "password", provider_user_id: u.id }), /CHECK/);
    await rejects(insLogin(u.id, { password_hash: "x" }), /CHECK/);
    await rejects(insLogin(u.id, { provider: "password", provider_user_id: u.id, password_hash: "" }), /CHECK/);
  });
  it("password provider_user_id must equal user_id", async () => {
    const u = await seedUser();
    await rejects(insLogin(u.id, { provider: "password", provider_user_id: "other", password_hash: "h" }), /CHECK/);
  });
  it("provider_user_id not empty; unique per provider; one login per (user, provider)", async () => {
    const u = await seedUser();
    const v = await seedUser();
    await rejects(insLogin(u.id, { provider_user_id: "" }), /CHECK/);
    await insLogin(u.id, { provider_user_id: "sub-same" });
    await rejects(insLogin(v.id, { provider_user_id: "sub-same" }), /UNIQUE/);
    await rejects(insLogin(u.id, { provider_user_id: "sub-other" }), /UNIQUE/);
  });
  it("provider and user_id never change", async () => {
    const u = await seedUser();
    const v = await seedUser();
    await insLogin(u.id);
    await rejects(run("UPDATE tenant_user_login SET provider = 'apple' WHERE user_id = ?", u.id), /never changes/);
    await rejects(run("UPDATE tenant_user_login SET user_id = ? WHERE user_id = ?", v.id, u.id), /never changes/);
  });
  it("trigger: the last login of a user cannot be deleted, one of several can", async () => {
    const u = await seedUser();
    await insLogin(u.id);
    await rejects(run("DELETE FROM tenant_user_login WHERE user_id = ?", u.id), /last login/);
    await insLogin(u.id, { provider: "apple" });
    await run("DELETE FROM tenant_user_login WHERE user_id = ? AND provider = 'apple'", u.id);
  });
  it("user must exist", async () => {
    await rejects(insLogin(uid()), /FOREIGN KEY/);
  });
});

describe("tenant_user_invite", () => {
  const insInvite = (hh: string, by: string, email: string, token = `t-${uid()}`) =>
    run("INSERT INTO tenant_user_invite (household_id, invited_by, email, token_hash) VALUES (?, ?, ?, ?)", hh, by, email, token);
  it("valid insert passes; email lowercase with @", async () => {
    const a = await seedHousehold();
    await insInvite(a.hh, a.owner, "dave@example.com");
    await rejects(insInvite(a.hh, a.owner, "Dave2@example.com"), /CHECK/);
    await rejects(insInvite(a.hh, a.owner, "dave2.example.com"), /CHECK/);
  });
  it("status must be open / accepted / rejected / cancelled", async () => {
    const a = await seedHousehold();
    await insInvite(a.hh, a.owner, "e1@example.com");
    await rejects(run("UPDATE tenant_user_invite SET status = 'maybe' WHERE email = 'e1@example.com'"), /CHECK/);
  });
  it("unique open invite per (household, email); a cancelled one frees the slot", async () => {
    const a = await seedHousehold();
    await insInvite(a.hh, a.owner, "f@example.com");
    await rejects(insInvite(a.hh, a.owner, "f@example.com"), /UNIQUE/);
    await run("UPDATE tenant_user_invite SET status = 'cancelled' WHERE email = 'f@example.com'");
    await insInvite(a.hh, a.owner, "f@example.com");
  });
  it("token_hash is unique", async () => {
    const a = await seedHousehold();
    await insInvite(a.hh, a.owner, "g1@example.com", "same");
    await rejects(insInvite(a.hh, a.owner, "g2@example.com", "same"), /UNIQUE/);
  });
  it("trigger: inviter's current household must be this household", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await run("INSERT INTO tenant_household_member (household_id, user_id) VALUES (?, ?)", b.hh, a.owner);
    await rejects(insInvite(b.hh, a.owner, "h@example.com"), /inviter/);
  });
  it("trigger: cannot invite someone whose current household is this one", async () => {
    const a = await seedHousehold();
    const u = await seedUser();
    await joinHousehold(u.id, a.hh);
    await rejects(insInvite(a.hh, a.owner, u.email), /already in/);
    const w = await seedUser();
    await insInvite(a.hh, a.owner, w.email);
  });
  it("household_id never changes", async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await insInvite(a.hh, a.owner, "i@example.com");
    await rejects(run("UPDATE tenant_user_invite SET household_id = ? WHERE email = 'i@example.com'", b.hh), /never changes/);
  });
  it("status moves only away from open, never back", async () => {
    const a = await seedHousehold();
    await insInvite(a.hh, a.owner, "j@example.com");
    await run("UPDATE tenant_user_invite SET status = 'rejected' WHERE email = 'j@example.com'");
    await rejects(run("UPDATE tenant_user_invite SET status = 'open' WHERE email = 'j@example.com'"), /only moves away/);
    await rejects(run("UPDATE tenant_user_invite SET status = 'cancelled' WHERE email = 'j@example.com'"), /only moves away/);
  });
  it("accepted needs a user with that email in this household", async () => {
    const a = await seedHousehold();
    const u = await seedUser();
    await insInvite(a.hh, a.owner, u.email);
    await rejects(run("UPDATE tenant_user_invite SET status = 'accepted' WHERE email = ?", u.email), /accepted needs a user/);
    await joinHousehold(u.id, a.hh);
    await run("UPDATE tenant_user_invite SET status = 'accepted' WHERE email = ?", u.email);
    expect((await row("SELECT status FROM tenant_user_invite WHERE email = ?", u.email)).status).toBe("accepted");
  });
  it("accepted refused after 24 hours (expiry enforced by the DB)", async () => {
    const a = await seedHousehold();
    const u = await seedUser();
    await joinHousehold(u.id, a.hh);
    const old = Math.floor(Date.now() / 1000) - 86400 - 60;
    await run("INSERT INTO tenant_user_invite (household_id, invited_by, email, token_hash, created_at) VALUES (?, ?, 'tmp@example.com', 'tk-old', ?)", a.hh, a.owner, old);
    await run("UPDATE tenant_user_invite SET email = ? WHERE token_hash = 'tk-old'", u.email);
    await rejects(run("UPDATE tenant_user_invite SET status = 'accepted' WHERE token_hash = 'tk-old'"), /invite expired/);
    await run("UPDATE tenant_user_invite SET status = 'cancelled' WHERE token_hash = 'tk-old'");
  });
});

describe.each([
  ["tenant_user_email_verification", 86400, "email"],
  ["tenant_user_password_reset", 3600, null],
] as const)("%s", (table, ttl, emailCol) => {
  const ins = (userId: string, created = Math.floor(Date.now() / 1000), token = `tk-${uid()}`) =>
    emailCol
      ? run(`INSERT INTO ${table} (user_id, email, token_hash, created_at) VALUES (?, 'p@example.com', ?, ?)`, userId, token, created)
      : run(`INSERT INTO ${table} (user_id, token_hash, created_at) VALUES (?, ?, ?)`, userId, token, created);
  it("valid insert passes; token_hash unique", async () => {
    const u = await seedUser();
    await ins(u.id, undefined, "dup");
    await rejects(ins(u.id, undefined, "dup"), /UNIQUE/);
  });
  it("user must exist", async () => {
    await rejects(ins(uid()), /FOREIGN KEY/);
  });
  it("used_at >= created_at", async () => {
    const u = await seedUser();
    await ins(u.id, 1000, "tk-a");
    await rejects(run(`UPDATE ${table} SET used_at = 999 WHERE token_hash = 'tk-a'`), /CHECK/);
  });
  it("used_at set once, then frozen", async () => {
    const u = await seedUser();
    await ins(u.id, 1000, "tk-b");
    await run(`UPDATE ${table} SET used_at = 1100 WHERE token_hash = 'tk-b'`);
    await rejects(run(`UPDATE ${table} SET used_at = 1200 WHERE token_hash = 'tk-b'`), /set once/);
    await rejects(run(`UPDATE ${table} SET used_at = NULL WHERE token_hash = 'tk-b'`), /set once/);
  });
  it(`expires ${ttl}s after created_at, enforced by the DB`, async () => {
    const u = await seedUser();
    await ins(u.id, 1000, "tk-c");
    await rejects(run(`UPDATE ${table} SET used_at = ? WHERE token_hash = 'tk-c'`, 1000 + ttl + 1), /expired/);
    await run(`UPDATE ${table} SET used_at = ? WHERE token_hash = 'tk-c'`, 1000 + ttl);
  });
  it("user_id never changes", async () => {
    const u = await seedUser();
    const v = await seedUser();
    await ins(u.id, undefined, "tk-d");
    await rejects(run(`UPDATE ${table} SET user_id = ? WHERE token_hash = 'tk-d'`, v.id), /never changes/);
  });
});

describe("tenant_user_email_verification email CHECK", () => {
  it("email lowercase with @", async () => {
    const u = await seedUser();
    await rejects(run("INSERT INTO tenant_user_email_verification (user_id, email, token_hash) VALUES (?, 'P@example.com', 'q1')", u.id), /CHECK/);
    await rejects(run("INSERT INTO tenant_user_email_verification (user_id, email, token_hash) VALUES (?, 'pexample.com', 'q2')", u.id), /CHECK/);
  });
});

describe("tenant_user_session", () => {
  const ins = (userId: string, hash = `r-${uid()}`, prev: string | null = null) =>
    run("INSERT INTO tenant_user_session (user_id, refresh_token_hash, previous_refresh_token_hash) VALUES (?, ?, ?)", userId, hash, prev);
  it("valid insert passes; refresh hash not empty and unique; previous hash unique", async () => {
    const u = await seedUser();
    await ins(u.id, "r1");
    await rejects(ins(u.id, "r1"), /UNIQUE/);
    await rejects(ins(u.id, ""), /CHECK/);
    await ins(u.id, "r2", "prev1");
    await rejects(ins(u.id, "r3", "prev1"), /UNIQUE/);
  });
  it("ended_at >= created_at; set once, never back to NULL", async () => {
    const u = await seedUser();
    await run("INSERT INTO tenant_user_session (user_id, refresh_token_hash, created_at) VALUES (?, 'r9', 1000)", u.id);
    await rejects(run("UPDATE tenant_user_session SET ended_at = 999 WHERE refresh_token_hash = 'r9'"), /CHECK/);
    await run("UPDATE tenant_user_session SET ended_at = 1100 WHERE refresh_token_hash = 'r9'");
    await rejects(run("UPDATE tenant_user_session SET ended_at = 1200 WHERE refresh_token_hash = 'r9'"), /set once/);
    await rejects(run("UPDATE tenant_user_session SET ended_at = NULL WHERE refresh_token_hash = 'r9'"), /set once/);
  });
  it("user_id never changes; last_used_at > 0", async () => {
    const u = await seedUser();
    const v = await seedUser();
    await ins(u.id, "r10");
    await rejects(run("UPDATE tenant_user_session SET user_id = ? WHERE refresh_token_hash = 'r10'", v.id), /never changes/);
    await rejects(run("UPDATE tenant_user_session SET last_used_at = 0 WHERE refresh_token_hash = 'r10'"), /CHECK/);
  });
});

describe("indexes", () => {
  it("the listed indexes exist", async () => {
    const names = (await (await import("./helpers")).rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
    for (const n of [
      "tenant_user_household_idx", "tenant_household_member_user_idx", "tenant_user_invite_open_email_uq", "tenant_user_invite_open_email_idx",
      "tenant_user_email_verification_user_idx", "tenant_user_password_reset_user_idx", "tenant_user_session_active_idx",
    ]) expect(names).toContain(n);
  });
});
