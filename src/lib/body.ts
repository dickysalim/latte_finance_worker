import type { Ctx } from "./http";
import { badRequest, tooLarge } from "./errors";

const MAX_BYTES = 16 * 1024;

/**
 * Read the JSON object of a request. Over 16 KB is 413, not JSON is 400.
 * `optional` lets a route without input accept an empty body (same as `{}`).
 */
export async function readBody(c: Ctx, optional = false): Promise<Record<string, unknown>> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES) throw tooLarge();
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw tooLarge();
  const text = new TextDecoder().decode(buf);
  if (text.trim() === "") {
    if (optional) return {};
    throw badRequest();
  }
  if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) throw badRequest();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw badRequest();
  return value as Record<string, unknown>;
}
