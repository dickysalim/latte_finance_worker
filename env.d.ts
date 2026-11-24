declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_URL: string;
    /** Comma separated Google OAuth client ids (public). Empty until the Google client exists. */
    GOOGLE_CLIENT_IDS: string;
    /** Sender shown on emails, for example "Latte Finance <noreply@example.com>". */
    MAIL_FROM: string;
    /** Wrangler secrets. Never in wrangler.toml or git. */
    JWT_SECRET: string;
    RESEND_API_KEY?: string;
    /** Cloudflare rate limiting bindings (5 and 20 calls per 60 seconds). */
    RL_5?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    RL_20?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
