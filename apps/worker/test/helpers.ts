import {
  type Db,
  ensurePerson,
  FakeSlackClient,
  newKeyB64,
  type PersonRow,
  schema,
  seal,
  setPersonUserToken,
  slackSignature,
  upsertWorkspace,
} from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import type { Deps } from "../src/deps";

export const SIGNING_SECRET = "test-signing-secret";
/** Thu 12 Nov 2026, 08:00 UTC = 10:00 in Asia/Jerusalem. */
export const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);
export const TZ = "Asia/Jerusalem";

export type TestDeps = Deps & {
  db: Db;
  slack: FakeSlackClient;
  tokenKey: string;
  clock: { now: number };
};

export function testDeps(overrides: Partial<Deps> = {}): TestDeps {
  const clock = { now: NOW };
  return {
    db: createTestDb(),
    slack: new FakeSlackClient(),
    tokenKey: newKeyB64(),
    fetchFn: fetch,
    now: () => clock.now,
    signingSecret: SIGNING_SECRET,
    slackClientId: "client-id",
    slackClientSecret: "client-secret",
    appUrl: "https://steward.example",
    clock,
    ...overrides,
  };
}

export async function seedWorkspace(
  deps: TestDeps,
  opts: { withUserToken: boolean } = { withUserToken: true },
): Promise<PersonRow> {
  await upsertWorkspace(deps.db, {
    id: "T1",
    name: "Acme",
    botTokenSealed: await seal(deps.tokenKey, "xoxb-bot"),
    botUserId: "UBOT",
    installedAt: NOW - 1000,
  });
  let person = await ensurePerson(deps.db, "T1", "U_DANA", "dana");
  await deps.db.update(schema.people).set({ tz: TZ }).where(eq(schema.people.id, person.id));
  if (opts.withUserToken)
    person = await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, "xoxp-dana"));
  return { ...person, tz: TZ };
}

type App = { request: (input: string, init?: RequestInit) => Promise<Response> | Response };

/** POSTs a form body to the app with a valid Slack signature for `nowMs`. */
export async function slackPost(
  app: App,
  path: string,
  form: Record<string, string>,
  nowMs = NOW,
): Promise<Response> {
  const body = new URLSearchParams(form).toString();
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = await slackSignature(SIGNING_SECRET, timestamp, body);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}
