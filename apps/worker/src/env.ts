export type Env = {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  /** 32 random bytes, base64 — see `newKeyB64()` in @steward/core. */
  TOKEN_KEY: string;
  /** Public origin of this Worker, no trailing slash, e.g. https://steward.example.workers.dev */
  APP_URL: string;
};
