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
  /** Run this after the response is sent (Slack wants an answer within 3 seconds). */
  defer: (work: Promise<unknown>) => void;
};

/**
 * The platform's fetch, safe to hand around. Workers throws "Illegal invocation" when `fetch` is
 * called as a method of another object, which `deps.fetchFn(...)` and `this.fetchFn(...)` are.
 * Node does not mind, so tests alone would not catch a bare `fetch` here.
 */
const platformFetch: typeof fetch = (input, init) => fetch(input, init);

export function depsFromEnv(env: Env, ctx: ExecutionContext): Deps {
  return {
    db: createD1Db(env.DB),
    slack: new RealSlackClient(platformFetch),
    fetchFn: platformFetch,
    now: () => Date.now(),
    signingSecret: env.SLACK_SIGNING_SECRET,
    tokenKey: env.TOKEN_KEY,
    slackClientId: env.SLACK_CLIENT_ID,
    slackClientSecret: env.SLACK_CLIENT_SECRET,
    appUrl: env.APP_URL,
    defer: (work) => ctx.waitUntil(work),
  };
}
