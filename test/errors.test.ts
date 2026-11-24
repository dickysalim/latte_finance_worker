import { describe, expect, it } from "vitest";
import { ApiError, conflict, invalid, mapDbError } from "../src/lib/errors";
import { defaultDeps } from "../src/lib/deps";
import { run, seedUser, seedHousehold, uid } from "./helpers";

const mapped = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { try { mapDbError(e); } catch (m) { return m as ApiError; } }
  throw new Error("expected a database error");
};

describe("error body", () => {
  it("is {error: {code, message, fields?}}", () => {
    expect(conflict("link_invalid", "x").toBody()).toEqual({ error: { code: "link_invalid", message: "x" } });
    expect(invalid({ email: "bad" }).toBody()).toEqual({ error: { code: "validation_failed", message: "Some fields are invalid", fields: { email: "bad" } } });
  });
});

describe("mapDbError: a DB rule error is never a 500", () => {
  it("UNIQUE email / username", async () => {
    const u = await seedUser({ username: "mapped-user" });
    const e1 = await mapped(run("INSERT INTO tenant_user (email, name) VALUES (?, 'x')", u.email));
    expect([e1.status, e1.code]).toEqual([409, "email_taken"]);
    const e2 = await mapped(run("INSERT INTO tenant_user (email, username, name) VALUES ('m2@example.com', 'mapped-user', 'x')"));
    expect([e2.status, e2.code]).toEqual([409, "username_taken"]);
  });
  it("CHECK to 422", async () => {
    const e = await mapped(run("INSERT INTO tenant_user (email, name) VALUES ('Bad@example.com', 'x')"));
    expect([e.status, e.code]).toEqual([422, "validation_failed"]);
  });
  it("trigger and FK to 409 conflict", async () => {
    const a = await seedHousehold();
    const e = await mapped(run("UPDATE tenant_household_member SET created_at = 5 WHERE user_id = ?", a.owner));
    expect([e.status, e.code]).toEqual([409, "conflict"]);
    const f = await mapped(run("INSERT INTO tenant_user_session (user_id, refresh_token_hash) VALUES (?, 'x')", uid()));
    expect(f.status).toBe(409);
  });
  it("expired link triggers to 409 link_expired", async () => {
    const u = await seedUser();
    await run("INSERT INTO tenant_user_password_reset (user_id, token_hash, created_at) VALUES (?, 'old', 1000)", u.id);
    const e = await mapped(run("UPDATE tenant_user_password_reset SET used_at = 999999 WHERE token_hash = 'old'"));
    expect([e.status, e.code]).toEqual([409, "link_expired"]);
  });
  it("non-constraint errors are rethrown", () => {
    expect(() => mapDbError(new Error("network down"))).toThrow("network down");
  });
});

describe("default deps", () => {
  it("random tokens are 43-char base64url, different each time", () => {
    const a = defaultDeps.randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(defaultDeps.randomToken()).not.toBe(a);
  });
  it("clock is epoch seconds", () => {
    expect(Math.abs(defaultDeps.now() - Date.now() / 1000)).toBeLessThan(2);
  });
});
