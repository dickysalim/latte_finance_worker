import { Hono } from "hono";
import { defaultDeps, type Deps } from "./lib/deps";
import { ApiError, notFound } from "./lib/errors";

export function createApp(_deps: Deps = defaultDeps) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.get("/health", async (c) => {
    // A cheap query proves the D1 binding works.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", service: "latte-finance-worker" });
  });

  app.notFound((c) => c.json(notFound().toBody(), 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  return app;
}
