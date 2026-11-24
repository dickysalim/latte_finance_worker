import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("/health", () => {
  it("answers ok and touches D1", async () => {
    const res = await createApp().request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "latte-finance-worker" });
  });

  it("unknown route is a JSON 404", async () => {
    const res = await createApp().request("/nope", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found", message: "Not found" } });
  });
});

describe("CORS", () => {
  const prod = "https://latte-finance-mobile.latte-factor.workers.dev";
  it("preflight from the web build is allowed", async () => {
    const res = await createApp().request(
      "/health",
      { method: "OPTIONS", headers: { Origin: prod, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } },
      env,
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(prod);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/content-type/i);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it.each(["http://localhost:8081", "http://localhost:5173"])("local origin %s is allowed", async (origin) => {
    const res = await createApp().request("/health", { headers: { Origin: origin } }, env);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  });
  it("other origins get no CORS header, errors keep it for allowed ones", async () => {
    const bad = await createApp().request("/health", { headers: { Origin: "https://evil.example.com" } }, env);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const nf = await createApp().request("/nope", { headers: { Origin: prod } }, env);
    expect(nf.status).toBe(404);
    expect(nf.headers.get("access-control-allow-origin")).toBe(prod);
  });
});
