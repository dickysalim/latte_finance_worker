import type { MiddlewareHandler } from "hono";
import type { AppEnv, Auth } from "./http";
import { signAccessToken, verifyAccessToken } from "./jwt";
import { ApiError } from "./errors";

/** Reads `Authorization: Bearer <access token>` and sets c.var.auth. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) throw new ApiError(401, "token_invalid", "Please login again");
  c.set("auth", await verifyAccessToken(c.env.JWT_SECRET, match[1]!, c.get("deps").now()));
  await next();
};

export const issueAccessToken = (c: Parameters<MiddlewareHandler<AppEnv>>[0], a: Auth) =>
  signAccessToken(c.env.JWT_SECRET, a, c.get("deps").now());
