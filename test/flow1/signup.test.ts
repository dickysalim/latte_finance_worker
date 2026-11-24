// Flow 1 test plan, sections 1, 4, 5, 11 (stories 1, 6, 7, 53): enumeration, notice mail, release, guards.
import { describe, expect, it } from "vitest";
import { row, rows, run } from "../helpers";
import { makeHarness } from "../flow";

const { h, api, lastToken, newUser } = makeHarness();
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const uname = (n: string) => `${n}${crypto.randomUUID().slice(0, 6)}`;
const code = (r: { json: any }) => r.json?.error?.code;
const signup = (e: string, u: string, extra: object = {}) => api("/normal-signup", { email: e, username: u, name: "Alice Test", password: "password123", ...extra });
const snapshot = async () =>
  JSON.stringify([
    await rows("SELECT * FROM tenant_user ORDER BY id"),
    await rows("SELECT * FROM tenant_user_login ORDER BY id"),
    await rows("SELECT * FROM tenant_user_email_verification ORDER BY id"),
  ]);

describe("F1-1 sign-up replies", () => {
  it("F1-1.09 verified email: reply identical to a fresh sign-up, nothing saved, one notice mail", async () => {
    const fresh = await signup(email("a"), uname("fresh"));
    const v = await newUser(email("v"), uname("ver"));
    const before = await snapshot();
    h.sent.length = 0;
    const again = await signup(v.email, uname("other"));
    expect(again.status).toBe(fresh.status);
    expect(again.json).toEqual(fresh.json);
    expect(await snapshot()).toBe(before);
    expect(h.sent.filter((m) => m.to === v.email)).toHaveLength(1);
    expect(h.sent.at(-1)!.subject).toMatch(/Someone tried to sign up/);
    expect(h.sent.at(-1)!.text).not.toMatch(/token=/);
  });

  it("F1-1.09b notice mail at most once per 60 seconds per address (story 54, rev 1210)", async () => {
    const v = await newUser(email("n"), uname("notice"));
    h.sent.length = 0;
    await signup(v.email, uname("x1"));
    await signup(v.email, uname("x2"));
    expect(h.sent.filter((m) => m.to === v.email)).toHaveLength(1);
    h.offset = 61;
    await signup(v.email, uname("x3"));
    h.offset = 0;
    expect(h.sent.filter((m) => m.to === v.email)).toHaveLength(2);
  });

  it("F1-1.16 username held by another verified account: 409 username_taken", async () => {
    const v = await newUser(email("h"), uname("held"));
    const taken = (await row("SELECT username u FROM tenant_user WHERE id = ?", v.id))!.u as string;
    const r = await signup(email("o"), taken);
    expect([r.status, code(r)]).toEqual([409, "username_taken"]);
  });

  it("F1-4 tab and new line in username are refused by the worker with 422", async () => {
    for (const bad of ["ab\tcd", "ab\ncd", "ab cd"]) {
      const r = await signup(email("t"), bad);
      expect([r.status, code(r)]).toEqual([422, "validation_failed"]);
      expect(r.json.error.fields.username).toBeTruthy();
    }
  });

  it("F1-4.13 body over 16 KB: 413 payload_too_large", async () => {
    const r = await signup(email("big"), uname("big"), { name: "x".repeat(20000) });
    expect([r.status, code(r)]).toEqual([413, "payload_too_large"]);
  });
});

describe("F1-6 verification and F1-53 release", () => {
  it("F1-6.03 wrong password: 403 wrong_password, token not consumed, right password works", async () => {
    const e = email("wp");
    await signup(e, uname("wp"));
    const tok = lastToken(e);
    const bad = await api("/email-verification", { token: tok, password: "wrong-password" });
    expect([bad.status, code(bad)]).toEqual([403, "wrong_password"]);
    expect((await row("SELECT used_at u FROM tenant_user_email_verification WHERE user_id = (SELECT id FROM tenant_user WHERE email = ?)", e))!.u).toBeNull();
    expect((await api("/email-verification", { token: tok, password: "password123" })).status).toBe(200);
  });

  it("F1-6.08 link 24 h edge: 24 h minus 2 s works, 24 h plus 2 s is link_expired", async () => {
    const a = email("e1");
    await signup(a, uname("e1"));
    h.offset = 86400 - 2;
    expect((await api("/email-verification", { token: lastToken(a), password: "password123" })).status).toBe(200);
    const b = email("e2");
    h.offset = 0;
    await signup(b, uname("e2"));
    h.offset = 86400 + 2;
    const r = await api("/email-verification", { token: lastToken(b), password: "password123" });
    h.offset = 0;
    expect([r.status, code(r)]).toEqual([409, "link_expired"]);
  });

  it("F1-6.15 two parallel verifications, same token: one 200, the other 409 link_invalid", async () => {
    const e = email("race");
    await signup(e, uname("race"));
    const t = lastToken(e);
    const [x, y] = await Promise.all([api("/email-verification", { token: t, password: "password123" }), api("/email-verification", { token: t, password: "password123" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(code(x.status === 409 ? x : y)).toBe("link_invalid");
  });

  it("F1-53 an unverified username is released after 24 h; the old link then says signup_abandoned", async () => {
    const e = email("rel");
    const name = uname("rel");
    await signup(e, name);
    const tok = lastToken(e);
    // Another sign-up cannot take the name inside 24 h.
    expect(code(await signup(email("m1"), name))).toBe("username_taken");
    await run("UPDATE tenant_user SET created_at = created_at - 86402 WHERE email = ?", e);
    await run("UPDATE tenant_user_email_verification SET created_at = created_at - 86402 WHERE user_id = (SELECT id FROM tenant_user WHERE email = ?)", e);
    const m = await signup(email("m2"), name);
    expect(m.status).toBe(202);
    const old = await row("SELECT username u FROM tenant_user WHERE email = ?", e);
    expect(old!.u).toBeNull();
    const l = await api("/login", { identifier: e, password: "password123" });
    expect([l.status, code(l)]).toEqual([403, "signup_abandoned"]);
    const v = await api("/email-verification", { token: tok, password: "password123" });
    expect(code(v)).toBe(v.status === 409 ? "link_expired" : "signup_abandoned");
  });
});

describe("F1-5 /login", () => {
  it("F1-7.15 abandoned account, right password: 403 signup_abandoned before email_not_verified", async () => {
    const e = email("ab");
    await signup(e, uname("ab"));
    await run("UPDATE tenant_user SET username = NULL WHERE email = ?", e);
    const r = await api("/login", { identifier: e, password: "password123" });
    expect([r.status, code(r)]).toEqual([403, "signup_abandoned"]);
    const w = await api("/login", { identifier: e, password: "bad-password" });
    expect([w.status, code(w)]).toEqual([401, "invalid_credentials"]);
  });
});
