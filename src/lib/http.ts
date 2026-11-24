import type { Context } from "hono";
import type { Deps } from "./deps";
import { rateLimited } from "./errors";

export type Auth = { uid: string; hid: string | null; sid: string };
export type AppEnv = { Bindings: Cloudflare.Env; Variables: { deps: Deps; auth: Auth } };
export type Ctx = Context<AppEnv>;

/** CF-Connecting-IP; without it (local dev, tests) every caller shares the key "unknown". */
export function clientIp(c: Ctx): string {
  const ip = c.req.header("CF-Connecting-IP");
  if (ip) return ip;
  console.warn("CF-Connecting-IP is missing, using the shared key 'unknown'");
  return "unknown";
}

/** Count one call under `key`; over the limit answers 429. */
export async function limit(c: Ctx, key: string, max: number): Promise<void> {
  if (!(await c.get("deps").rateLimit(key, max, 60))) throw rateLimited();
}
