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
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});
