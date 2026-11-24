import { newToken } from "./crypto";
import { ApiError } from "./errors";

export type GoogleProfile = { sub: string; email: string; emailVerified: boolean; name: string };
export type EmailMessage = { to: string; subject: string; text: string };

/**
 * Everything a route needs from the outside world. Routes read these through
 * one object so tests can replace the clock, tokens, Google, email and limiter.
 */
export type Deps = {
  /** Current time in epoch seconds. */
  now: () => number;
  /** 32 random bytes, base64url without padding. */
  randomToken: () => string;
  /** `audiences` are our Google OAuth client ids. Not valid: 401 google_token_invalid. */
  verifyGoogleToken: (idToken: string, audiences: string[]) => Promise<GoogleProfile>;
  /** Sender is Resend in production. A failed send must never undo saved rows. */
  sendEmail: (msg: EmailMessage) => Promise<void>;
  /** True when the call is allowed, false when over `limit` calls per `windowSeconds`. */
  rateLimit: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
};

const googleInvalid = () => new ApiError(401, "google_token_invalid", "Google token is not valid");

/** Google ID token check through Google's tokeninfo endpoint. */
async function verifyGoogleToken(idToken: string, audiences: string[]): Promise<GoogleProfile> {
  let p: Record<string, string>;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw googleInvalid();
    p = (await res.json()) as Record<string, string>;
  } catch {
    throw googleInvalid();
  }
  const issuerOk = p.iss === "accounts.google.com" || p.iss === "https://accounts.google.com";
  if (!p.sub || !p.aud || !audiences.includes(p.aud) || !issuerOk) throw googleInvalid();
  return { sub: p.sub, email: (p.email ?? "").toLowerCase(), emailVerified: p.email_verified === "true", name: p.name ?? "" };
}

/** Never log the body: it holds a link token. */
async function sendEmail(msg: EmailMessage, env?: Cloudflare.Env): Promise<void> {
  if (env?.EMAIL_MODE === "log") {
    // Local stub (.dev.vars only): sends nothing, prints the links so a tester can open them.
    const links = msg.text.match(/https?:\/\/\S+/g) ?? [];
    console.log(`[mail:log] to=${msg.to} subject="${msg.subject}" links=${JSON.stringify(links)}`);
    return;
  }
  if (!env?.RESEND_API_KEY) {
    console.log(`[mail] RESEND_API_KEY not set, not sending "${msg.subject}" to ${msg.to}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

/** Cloudflare rate limiting bindings: RL_5 (5 per 60 s) and RL_20 (20 per 60 s). No binding: allow. */
async function rateLimit(key: string, max: number, _windowSeconds: number, env?: Cloudflare.Env): Promise<boolean> {
  const binding = max === 5 ? env?.RL_5 : max === 20 ? env?.RL_20 : undefined;
  if (!binding) return true;
  return (await binding.limit({ key })).success;
}

const base: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  randomToken: newToken,
  verifyGoogleToken,
  sendEmail: (msg) => sendEmail(msg),
  rateLimit: (key, max, windowSeconds) => rateLimit(key, max, windowSeconds),
};

/** Deps for tests and local code without bindings. */
export const defaultDeps: Deps = base;

/** Deps wired to this request's bindings (Resend, rate limiting). */
export const depsFor = (env: Cloudflare.Env): Deps => ({
  ...base,
  sendEmail: (msg) => sendEmail(msg, env),
  rateLimit: (key, max, windowSeconds) => rateLimit(key, max, windowSeconds, env),
});
