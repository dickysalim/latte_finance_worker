declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_URL: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
