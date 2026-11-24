import { invalid } from "./errors";

/** Lowercase and trim, or null when the value is not a string. */
export const clean = (v: unknown): string | null => (typeof v === "string" ? v.trim().toLowerCase() : null);

const hasSpace = (s: string) => /\s/.test(s);

export const MSG = {
  email: "Enter a valid email",
  username: "3 to 30 characters, no spaces or @",
  name: "Enter your name (up to 100 characters)",
  password: "8 to 128 characters",
};

export function emailError(v: string | null): string | null {
  if (v === null || v.length > 254 || hasSpace(v)) return MSG.email;
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@") || at === v.length - 1) return MSG.email;
  return null;
}

export function usernameError(v: string | null): string | null {
  if (v === null || v.length < 3 || v.length > 30 || hasSpace(v) || v.includes("@")) return MSG.username;
  return null;
}

export function nameError(v: string | null): string | null {
  return v === null || v.length < 1 || v.length > 100 ? MSG.name : null;
}

export function passwordError(v: unknown): string | null {
  return typeof v !== "string" || v.length < 8 || v.length > 128 ? MSG.password : null;
}

/** A required non-empty string such as a token or an id. */
export const requiredString = (v: unknown, message: string): string | null =>
  typeof v === "string" && v.trim() !== "" ? null : message;

/** Throw 422 with every field that has a message. */
export function failOnFields(checks: Record<string, string | null>): void {
  const fields = Object.fromEntries(Object.entries(checks).filter(([, m]) => m !== null)) as Record<string, string>;
  if (Object.keys(fields).length > 0) throw invalid(fields);
}
