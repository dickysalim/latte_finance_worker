import { Hono } from "hono";
import { ApiError } from "./lib/errors";

export function createApp() {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  app.get("/health", async (c) => {
    // A cheap query proves the D1 binding works.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", service: "latte-finance-worker" });
  });

  app.notFound((c) => c.json({ error: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
    }
    console.error(err);
    return c.json({ error: "internal", message: "Something went wrong" }, 500);
  });

  return app;
}
