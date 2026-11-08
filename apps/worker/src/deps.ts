import { type Db, RealSlackClient, type SlackClient } from "@steward/core";
import { createD1Db } from "./db";
import type { Env } from "./env";

/** Everything the app needs, built once per request in production and by hand in tests. */
export type Deps = {
  db: Db;
  slack: SlackClient;
  fetchFn: typeof fetch;
  now: () => number;
  signingSecret: string;
  tokenKey: string;
  slackClientId: string;
  slackClientSecret: string;
  appUrl: string;
};

export function depsFromEnv(env: Env): Deps {
  return {
    db: createD1Db(env.DB),
    slack: new RealSlackClient(fetch),
    fetchFn: fetch,
    now: () => Date.now(),
    signingSecret: env.SLACK_SIGNING_SECRET,
    tokenKey: env.TOKEN_KEY,
    slackClientId: env.SLACK_CLIENT_ID,
    slackClientSecret: env.SLACK_CLIENT_SECRET,
    appUrl: env.APP_URL,
  };
}
