import { Hono } from "hono";
import { cors } from "hono/cors";
import { defaultDeps, type Deps } from "./lib/deps";
import { ApiError, notFound } from "./lib/errors";

export const ALLOWED_ORIGINS = [
  "https://latte-finance-mobile.latte-factor.workers.dev",
  "http://localhost:8081", // Expo web
  "http://localhost:5173",
];

export function createApp(_deps: Deps = defaultDeps) {
  const app = new Hono<{ Bindings: Cloudflare.Env }>();

  // The web build calls the API from another origin. Bearer token, no cookies, so no credentials.
  app.use(
    "*",
    cors({
      origin: ALLOWED_ORIGINS,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  );

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
