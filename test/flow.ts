import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { defaultDeps, type Deps, type EmailMessage, type GoogleProfile } from "../src/lib/deps";
import { ApiError } from "../src/lib/errors";
import { hashToken } from "../src/lib/crypto";
import { row, run } from "./helpers";

/** Controllable deps: clock offset, captured emails, in-memory rate limiter, fake Google. */
export function makeHarness() {
  const h = {
    offset: 0,
    sent: [] as EmailMessage[],
    google: new Map<string, GoogleProfile>(),
    counts: new Map<string, number>(),
    limitsOn: false,
    failEmail: false,
    clientIds: "test-client-id",
    longHits: new Map<string, number>(),
    deps_now: () => Math.floor(Date.now() / 1000) + h.offset,
  };
  const deps: Deps = {
    ...defaultDeps,
    now: () => Math.floor(Date.now() / 1000) + h.offset,
    sendEmail: async (m) => {
      if (h.failEmail) throw new Error("mail down");
      h.sent.push(m);
    },
    verifyGoogleToken: async (idToken) => {
      const p = h.google.get(idToken);
      if (!p) throw new ApiError(401, "google_token_invalid", "Google token is not valid");
      return p;
    },
    rateLimit: async (key, max, windowSeconds) => {
      if (max === 1) {
        // The notice mail (limit 1 per 60 s) always count, by the injected clock.
        const at = h.longHits.get(key);
        if (at !== undefined && h.deps_now() < at + windowSeconds) return false;
        h.longHits.set(key, h.deps_now());
        return true;
      }
      if (!h.limitsOn) return true;
      const n = (h.counts.get(key) ?? 0) + 1;
      h.counts.set(key, n);
      return n <= max;
    },
  };
  const app = createApp(deps);
  const e = () => ({ ...env, GOOGLE_CLIENT_IDS: h.clientIds }) as Cloudflare.Env;

  async function api(path: string, body: unknown = {}, opts: { token?: string; ip?: string; raw?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
    const res = await app.request(path, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }, e());
    const json = (await res.json().catch(() => null)) as any;
    return { status: res.status, json, headers: res.headers };
  }

  const lastToken = (to?: string) => {
    const m = [...h.sent].reverse().find((x) => !to || x.to === to);
    return /token=([A-Za-z0-9_-]+)/.exec(m?.text ?? "")?.[1] as string;
  };

  /** Sign up, verify and log in. Returns tokens and ids. */
  async function newUser(email: string, username: string, password = "password123", name = "Alice Test") {
    expect((await api("/normal-signup", { email, username, name, password })).status).toBe(202);
    expect((await api("/email-verification", { token: lastToken(email), password })).status).toBe(200);
    const login = await api("/login", { identifier: email, password });
    expect(login.status).toBe(200);
    const id = (await row<{ id: string }>("SELECT id FROM tenant_user WHERE email = ?", email))!.id;
    return { id, email, password, access: login.json.access_token as string, refresh: login.json.refresh_token as string };
  }

  /** A user with a household of their own. */
  async function newHouseholdUser(email: string, username: string) {
    const u = await newUser(email, username);
    const r = await api("/first-login-household", {}, { token: u.access });
    expect(r.status).toBe(200);
    return { ...u, access: r.json.access_token as string, household: r.json.household_id as string };
  }

  /** An open invite into the household, with a known raw token. */
  async function seedInvite(householdId: string, invitedBy: string, email: string, createdAt?: number) {
    const token = `invite-token-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    await run(
      "INSERT INTO tenant_user_invite (id, household_id, invited_by, email, token_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
      id, householdId, invitedBy, email, await hashToken(token), createdAt ?? deps.now(), createdAt ?? deps.now(),
    );
    return { id, token };
  }

  return { h, deps, app, api, lastToken, newUser, newHouseholdUser, seedInvite };
}
