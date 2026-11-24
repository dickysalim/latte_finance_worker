import { Hono } from "hono";
import { cors } from "hono/cors";
import { depsFor, type Deps } from "./lib/deps";
import type { AppEnv } from "./lib/http";
import { signup } from "./routes/signup";
import { session } from "./routes/session";
import { household } from "./routes/household";
import { ApiError, notFound } from "./lib/errors";

export const ALLOWED_ORIGINS = [
  "https://latte-finance-mobile.latte-factor.workers.dev",
  "http://localhost:8081", // Expo web
  "http://localhost:5173",
];

export function createApp(deps?: Deps) {
  const app = new Hono<AppEnv>();

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

  // One deps object per request: tests pass their own, production builds it from the bindings.
  app.use("*", async (c, next) => {
    c.set("deps", deps ?? depsFor(c.env));
    await next();
  });

  app.get("/health", async (c) => {
    // A cheap query proves the D1 binding works.
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", service: "latte-finance-worker" });
  });

  app.route("/", signup);
  app.route("/", session);
  app.route("/", household);

  app.notFound((c) => c.json(notFound().toBody(), 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status === 429) c.header("Retry-After", "60");
      return c.json(err.toBody(), err.status);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  return app;
}
