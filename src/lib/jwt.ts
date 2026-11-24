import { ApiError } from "./errors";
import type { Auth } from "./http";

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

const invalidToken = () => new ApiError(401, "token_invalid", "Please login again");

/** HS256 access token: sub = user id, hid = household id or null, sid = session id, exp = iat + 900. */
export async function signAccessToken(secret: string, a: Auth, now: number): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ sub: a.uid, hid: a.hid, sid: a.sid, iat: now, exp: now + 900 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Missing, malformed or bad signature: 401 token_invalid. Expired: 401 token_expired. */
export async function verifyAccessToken(secret: string, token: string, now: number): Promise<Auth> {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalidToken();
  const [head, body, sig] = parts as [string, string, string];
  let claims: Record<string, unknown>;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(head)));
    if (header.alg !== "HS256") throw invalidToken();
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64url(sig), enc.encode(`${head}.${body}`));
    if (!ok) throw invalidToken();
    claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch (e) {
    throw e instanceof ApiError ? e : invalidToken();
  }
  const { sub, hid, sid, exp } = claims;
  if (typeof sub !== "string" || typeof sid !== "string" || typeof exp !== "number" || !(hid === null || typeof hid === "string")) {
    throw invalidToken();
  }
  if (exp <= now) throw new ApiError(401, "token_expired", "Please refresh your session");
  return { uid: sub, hid, sid };
}
