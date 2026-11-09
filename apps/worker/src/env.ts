/** Cloudflare's rate limiting binding, as far as the demo uses it. */
export type DemoLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  /** 32 random bytes, base64 — see `newKeyB64()` in @steward/core. */
  TOKEN_KEY: string;
  /** Public origin of this Worker, no trailing slash, e.g. https://steward.example.workers.dev */
  APP_URL: string;
  /** "1" turns the public demo (/demo/*) on. Anything else, or unset, leaves it off. */
  DEMO_ENABLED?: string;
  /** Per-visitor rate limit for /demo/* (the `[[ratelimits]]` binding in wrangler.toml). */
  DEMO_LIMITER?: DemoLimiter;
  /** All demo traffic together (the second `[[ratelimits]]` binding in wrangler.toml). */
  DEMO_GLOBAL_LIMITER?: DemoLimiter;
};
