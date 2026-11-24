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
  verifyGoogleToken: (idToken: string, clientId: string) => Promise<GoogleProfile>;
  /** Sender is Resend in production. A failed send must never undo saved rows. */
  sendEmail: (msg: EmailMessage) => Promise<void>;
  /** True when the call is allowed, false when over `limit` calls per `windowSeconds`. */
  rateLimit: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
};

/** Google ID token check through Google's tokeninfo endpoint. */
async function verifyGoogleToken(idToken: string, clientId: string): Promise<GoogleProfile> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) throw new ApiError(401, "token_invalid", "Google token is not valid");
  const p = (await res.json()) as Record<string, string>;
  if (!clientId || p.aud !== clientId) throw new ApiError(401, "token_invalid", "Google token is not valid");
  return { sub: p.sub!, email: (p.email ?? "").toLowerCase(), emailVerified: p.email_verified === "true", name: p.name ?? "" };
}

/** Placeholder until Resend is wired. Logs only the recipient, never the body (it holds a link token). */
async function sendEmail(msg: EmailMessage): Promise<void> {
  console.log(`[mail] would send "${msg.subject}" to ${msg.to}`);
}

/** Placeholder until the limiter is chosen: allows everything. */
async function rateLimit(): Promise<boolean> {
  return true;
}

export const defaultDeps: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  randomToken: newToken,
  verifyGoogleToken,
  sendEmail,
  rateLimit,
};
