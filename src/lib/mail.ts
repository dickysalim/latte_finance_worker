import type { Deps } from "./deps";

/** A failed send never undoes saved rows: the error is logged without the body (it holds a token). */
async function trySend(deps: Deps, to: string, subject: string, text: string): Promise<void> {
  try {
    await deps.sendEmail({ to, subject, text });
  } catch (err) {
    console.error(`[mail] send failed for "${subject}":`, err instanceof Error ? err.message : "unknown error");
  }
}

export const sendVerificationEmail = (deps: Deps, appUrl: string, to: string, token: string) =>
  trySend(
    deps,
    to,
    "Verify your Latte Finance email",
    `Open this link to verify your email. It works for 24 hours.\n\n${appUrl}/verify?token=${token}\n\nIf you did not sign up, ignore this email.`,
  );

export const sendAlreadyRegisteredEmail = (deps: Deps, to: string) =>
  trySend(
    deps,
    to,
    "Someone tried to sign up with your email",
    "Someone tried to sign up with your email. If it was you, log in or reset your password.",
  );
