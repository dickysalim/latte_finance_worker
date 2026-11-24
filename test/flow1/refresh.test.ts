// Flow 1 test plan, section 9 (story 11): /refresh grace rules of design revision 1201.
// Case ids (F1-11.nn) point to latte_finance_tests/flow-1-plan.md.
import { describe, expect, it } from "vitest";
import { hashToken } from "../../src/lib/crypto";
import { row, run } from "../helpers";
import { makeHarness } from "../flow";

const { h, api, newUser } = makeHarness();
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const uname = (n: string) => `${n}${crypto.randomUUID().slice(0, 6)}`;
const session = (userId: string) => row("SELECT * FROM tenant_user_session WHERE user_id = ? ORDER BY created_at DESC", userId);
const refresh = (token: string) => api("/refresh", { refresh_token: token });
const code = (r: { json: any }) => r.json?.error?.code;

/** The clock is real time plus h.offset; session rows get last_used_at from that same clock. */
async function fresh() {
  h.offset = 0;
  const u = await newUser(email("rf"), uname("rf"));
  return u;
}

describe("F1-11 refresh grace (rev 1201)", () => {
  it("F1-11.01/02 normal renewal moves previous and last_used_at", async () => {
    const u = await fresh();
    const t0 = Math.floor(Date.now() / 1000);
    const r = await refresh(u.refresh);
    expect(r.status).toBe(200);
    expect(r.json.refresh_token).not.toBe(u.refresh);
    const s = await session(u.id);
    expect(s.refresh_token_hash).toBe(await hashToken(r.json.refresh_token));
    expect(s.previous_refresh_token_hash).toBe(await hashToken(u.refresh));
    expect(s.last_used_at).toBeGreaterThanOrEqual(t0);
    expect(s.ended_at).toBeNull();
  });

  it("F1-11.09 grace: T1 again gives 200, previous = replaced current (T2), last_used_at unchanged", async () => {
    const u = await fresh();
    const t2 = (await refresh(u.refresh)).json.refresh_token as string;
    const before = await session(u.id);
    h.offset = 30;
    const r = await refresh(u.refresh);
    h.offset = 0;
    expect(r.status).toBe(200);
    const s = await session(u.id);
    expect(s.refresh_token_hash).toBe(await hashToken(r.json.refresh_token));
    expect(s.previous_refresh_token_hash).toBe(await hashToken(t2));
    expect(s.last_used_at).toBe(before.last_used_at);
  });

  it("F1-11.10 after the grace renewal the first reply (T2) is still good", async () => {
    const u = await fresh();
    const t2 = (await refresh(u.refresh)).json.refresh_token as string;
    h.offset = 30;
    expect((await refresh(u.refresh)).status).toBe(200);
    const r = await refresh(t2);
    h.offset = 0;
    expect(r.status).toBe(200);
  });

  it("F1-11.11/12/13 boundary: 59 ok, 60 and 61 end only this session", async () => {
    const u = await fresh();
    const other = await api("/login", { identifier: u.email, password: u.password });
    await refresh(u.refresh);
    h.offset = 59;
    expect((await refresh(u.refresh)).status).toBe(200);
    h.offset = 0;

    const v = await fresh();
    const vOther = await api("/login", { identifier: v.email, password: v.password });
    await refresh(v.refresh);
    h.offset = 60;
    const at60 = await refresh(v.refresh);
    h.offset = 0;
    expect([at60.status, code(at60)]).toEqual([401, "session_ended"]);
    expect((await refresh(vOther.json.refresh_token)).status).toBe(200);

    const w = await fresh();
    await refresh(w.refresh);
    h.offset = 61;
    const at61 = await refresh(w.refresh);
    h.offset = 0;
    expect([at61.status, code(at61)]).toEqual([401, "session_ended"]);
    const ended = await row("SELECT ended_at e FROM tenant_user_session WHERE user_id = ?", w.id);
    expect(ended!.e).toBeGreaterThan(0);
    expect((await refresh(other.json.refresh_token)).status).toBe(200);
  });

  it("F1-11.14 after a too-late replay the current token is dead as well", async () => {
    const u = await fresh();
    const t2 = (await refresh(u.refresh)).json.refresh_token as string;
    h.offset = 61;
    expect(code(await refresh(u.refresh))).toBe("session_ended");
    expect(code(await refresh(t2))).toBe("session_ended");
    h.offset = 0;
  });

  it("F1-11.15 grace chain through the previous token: the window does not stretch", async () => {
    const u = await fresh();
    const t2 = (await refresh(u.refresh)).json.refresh_token as string;
    const first = await session(u.id);
    h.offset = 20;
    const t3 = (await refresh(u.refresh)).json.refresh_token as string;
    h.offset = 40;
    // previous is now T2 (the replaced current hash), so T2 renews again inside the same window.
    const t4 = await refresh(t2);
    expect(t4.status).toBe(200);
    expect(t3).not.toBe(t4.json.refresh_token);
    h.offset = 0;
    expect((await session(u.id)).last_used_at).toBe(first.last_used_at);
    // T1 is two generations old: not remembered, no kill.
    expect(code(await refresh(u.refresh))).toBe("session_ended");
    expect((await session(u.id)).ended_at).toBeNull();
  });

  it("F1-11.16 normal renewal after grace; the older generation is not remembered and does not kill", async () => {
    const u = await fresh();
    await refresh(u.refresh);
    h.offset = 20;
    const t3 = (await refresh(u.refresh)).json.refresh_token as string;
    h.offset = 40;
    const t4 = await refresh(t3);
    expect(t4.status).toBe(200);
    const s = await session(u.id);
    expect(s.previous_refresh_token_hash).toBe(await hashToken(t3));
    h.offset = 0;
    const old = await refresh(u.refresh);
    expect(code(old)).toBe("session_ended");
    // An unknown token never kills the live session.
    expect((await session(u.id)).ended_at).toBeNull();
  });

  it("F1-11.17 true double send: never 409 or 500, at least one reply stays usable", async () => {
    const u = await fresh();
    const [a, b] = await Promise.all([refresh(u.refresh), refresh(u.refresh)]);
    for (const r of [a, b]) expect([200, 401]).toContain(r.status);
    expect([a.status, b.status]).toContain(200);
    for (const r of [a, b]) if (r.status === 401) expect(code(r)).toBe("session_ended");
    const winners = [a, b].filter((r) => r.status === 200).map((r) => r.json.refresh_token as string);
    const usable: number[] = [];
    for (const t of winners) usable.push((await refresh(t)).status);
    expect(usable).toContain(200);
    expect((await session(u.id)).ended_at).toBeNull();
  });

  it("F1-11.19 lost reply: retry with the old token inside 60 s works", async () => {
    const u = await fresh();
    await refresh(u.refresh);
    h.offset = 10;
    expect((await refresh(u.refresh)).status).toBe(200);
    h.offset = 0;
  });

  it("F1-11.20 grace on an ended session stays ended", async () => {
    const u = await fresh();
    await refresh(u.refresh);
    await run("UPDATE tenant_user_session SET ended_at = unixepoch() WHERE user_id = ?", u.id);
    const r = await refresh(u.refresh);
    expect([r.status, code(r)]).toEqual([401, "session_ended"]);
    expect((await session(u.id)).ended_at).not.toBeNull();
  });

  it("F1-11.21 grace on a deactivated user: 403 account_deactivated (sheet 1207), session ended", async () => {
    const u = await fresh();
    await refresh(u.refresh);
    await run("UPDATE tenant_user SET is_active = 0 WHERE id = ?", u.id);
    const r = await refresh(u.refresh);
    expect([r.status, code(r)]).toEqual([403, "account_deactivated"]);
    expect((await session(u.id)).ended_at).not.toBeNull();
  });

  it("F1-11.22 grace past 30 idle days: the 30-day check applies", async () => {
    const u = await fresh();
    await refresh(u.refresh);
    await run("UPDATE tenant_user_session SET last_used_at = last_used_at - 2592001 WHERE user_id = ?", u.id);
    const r = await refresh(u.refresh);
    expect([r.status, code(r)]).toEqual([401, "session_expired"]);
  });

  it("F1-11.18 never 409 on /refresh", async () => {
    const u = await fresh();
    const seen: number[] = [];
    seen.push((await refresh(u.refresh)).status, (await refresh(u.refresh)).status, (await refresh("nope")).status);
    expect(seen).not.toContain(409);
    expect(seen).not.toContain(500);
  });
});
