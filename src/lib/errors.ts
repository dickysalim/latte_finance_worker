/** Statuses the contracts allow (see "convention: errors" in design/api_contracts.md). */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429;

/** Error reply body: {"error": {"code", "message", "fields"?, "details"?}}. `fields` only on 422; `details` only where a route says so. */
export class ApiError extends Error {
  constructor(
    public status: ErrorStatus,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}), ...(this.details ? { details: this.details } : {}) } };
  }
}

export const badRequest = () => new ApiError(400, "bad_request", "Request body is not valid JSON");
export const forbidden = (message = "You are not allowed to do this") => new ApiError(403, "forbidden", message);
export const notFound = (message = "Not found") => new ApiError(404, "not_found", message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, undefined, details);
export const tooLarge = () => new ApiError(413, "payload_too_large", "Request body is too large");
export const invalid = (fields: Record<string, string>) => new ApiError(422, "validation_failed", "Some fields are invalid", fields);
export const rateLimited = () => new ApiError(429, "rate_limited", "Too many attempts, please wait a minute");

/**
 * Turn a D1 constraint error (UNIQUE, CHECK, FK, trigger) into an ApiError.
 * A DB rule error is never a 500. Routes catch their own known cases first and
 * pass the rest here. Anything that is not a constraint error is rethrown.
 */
export function mapDbError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("SQLITE_CONSTRAINT")) throw err;
  if (msg.includes("UNIQUE constraint failed")) {
    if (msg.includes("tenant_user.email")) throw conflict("email_taken", "Email is already registered");
    if (msg.includes("tenant_user.username")) throw conflict("username_taken", "Username is already taken");
    if (msg.includes("tenant_user_login.provider")) throw conflict("google_taken", "This Google account is already registered");
    throw conflict("conflict", "This value already exists");
  }
  if (msg.includes("invite expired")) throw conflict("invite_expired", "This invite has expired");
  if (msg.includes("link expired")) throw conflict("link_expired", "This link has expired");
  if (msg.includes("accepted needs a user")) throw conflict("invite_invalid", "This invite is not valid");
  if (msg.includes("CHECK constraint failed")) throw new ApiError(422, "validation_failed", "A value was rejected by the database rules");
  throw conflict("conflict", "The request conflicts with the current state");
}
