import { afterEach, describe, expect, it, vi } from "vitest";
import { depsFromEnv } from "../src/deps";
import type { Env } from "../src/env";

const env: Env = {
  DB: {} as D1Database,
  SLACK_SIGNING_SECRET: "signing-secret",
  SLACK_CLIENT_ID: "client-id",
  SLACK_CLIENT_SECRET: "client-secret",
  TOKEN_KEY: "token-key",
  APP_URL: "https://steward.example",
};
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("depsFromEnv", () => {
  // Cloudflare Workers throws "Illegal invocation" when the platform's fetch is called as a method
  // of another object. Node does not, so only looking at the receiver catches it here.
  it("never calls the platform fetch as a method of another object", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(new Response("ok"));
    });
    const deps = depsFromEnv(env, ctx);
    await deps.fetchFn("https://example.com/");
    await deps.slack.respond({ responseUrl: "https://hooks.slack.com/actions/T/B/x", text: "hi" });
    expect(receivers).toHaveLength(2);
    for (const receiver of receivers) {
      expect(receiver === undefined || receiver === globalThis).toBe(true);
    }
  });
});
