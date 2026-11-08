# Steward · Plan 2a: Deploy Gates and Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps the Plan 1 final review named before any real deploy — people's time zones and names read from Slack, no promise the product can't keep yet, hardened Slack clients and handlers, a real-D1 smoke test, and a deploy runbook with a Slack app manifest — so the owner can deploy Steward Availability the day the accounts exist.

**Architecture:** No new packages. `@steward/core` gains `users.info` on the Slack client (real and fake), a `profile_synced_at` column and `updatePersonProfile`, a trusted-URL check for `response_url`, and a Miniflare-backed D1 smoke test. `@steward/availability`'s submission reader takes "today" in the person's zone and refuses future start dates until scheduling lands (Plan 3). `apps/worker` resolves people through `personForSlackUser` (sync from Slack on first contact, refresh daily), guards malformed payloads and unreadable tokens, uses fixed plain sentences for failures and logs the detail, and handles OAuth cancel and outage honestly. The repo gets a deploy runbook, a Slack app manifest, `.gitattributes`, and a CI deploy job that runs only when the Cloudflare secrets exist.

**Tech Stack:** as Plan 1 — TypeScript 5.9, pnpm, Hono 4, Drizzle (sqlite-core; D1 in production, better-sqlite3 in tests), Vitest 3, Biome 2.6, Wrangler 4 — plus `miniflare` ^4 as a core devDependency for the D1 smoke test.

## Global Constraints

- TypeScript end to end; Node `>=22`; ESM everywhere. `packages/*/src` and `apps/worker/src` use only web-standard APIs (Cloudflare Workers with `nodejs_compat`); Node-only imports live in `*/testing.ts` and test files.
- Slack in HTTP mode; every `/slack/*` request is signature-verified before anything else; `view_submission` and `block_actions` are acknowledged within 3 seconds (validation synchronous, work via `deps.defer`).
- Principles (spec §3): parse then review; act only on a yes; receipts and Undo; **honest states** — nothing is promised that the product cannot do yet, failures are reported in plain words, and nothing is reported as done that was not confirmed; one save path.
- Tokens are never stored, logged or returned in clear. `console.error` lines carry an error object or code, never a token or a `response_url`.
- Tenancy: every `statuses` query is scoped by `workspace_id` as well as by person.
- `response_url` targets must be `https://hooks.slack.com/...`; anything else is refused with `SlackApiError("response_url", "untrusted_url")`.
- Nothing from any employer — no company names, org vocabulary or people — in code, comments, fixtures or docs. Fictional names Dana, Omer, Noa, Acme.
- Commits: conventional prefixes, one commit per task, each ending with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer naming the Claude model that made the commit.
- Run everything from the repo root `C:\Users\nafta\steward`. The lint script covers `packages apps package.json tsconfig.base.json vitest.config.ts`; `biome.json` is hook-protected — do not edit it. Biome prints a schema-version notice; ignore it.
- Each task ends with `pnpm test`, `pnpm typecheck` (four `tsc` runs) and `pnpm lint` all green.

---

## File structure

```
packages/core/
  src/slack/client.ts            + UserProfile, getUserInfo, parseJson guard, assertTrustedResponseUrl
  src/slack/fake.ts              + users map, userInfoCalls, getUserInfo; respond checks the URL
  src/db/schema.ts               people.profile_synced_at
  drizzle/0001_*.sql             generated
  src/db/repo.ts                 ensurePerson onConflictDoNothing; updatePersonProfile
  src/db/d1.smoke.test.ts        Miniflare D1 smoke (Node only)
  src/index.ts                   exports
packages/availability/
  src/status/form.ts             readStatusSubmission(view, { today }); date/text/emoji validation
  src/status/service.ts          getStatus(db, id, workspaceId)
apps/worker/
  src/people.ts                  personForSlackUser
  src/routes/slack.ts            person before validation; guards; fixed sentences; logs
  src/routes/oauth.ts            cancel and outage paths
  slack-manifest.json            Slack app manifest (APP_HOST placeholder)
  test/people.test.ts            profile sync flow tests
  test/helpers.ts                seedWorkspace({ withUserToken, profileSynced })
.gitattributes                   * text=auto eol=lf
.github/workflows/ci.yml         deploy job gated on CLOUDFLARE_API_TOKEN
README.md                        Deploy runbook
```

---

### Task 1: Time zone and display name from Slack (`users.info`)

**Files:**
- Modify: `packages/core/src/slack/client.ts`, `packages/core/src/slack/fake.ts`, `packages/core/src/db/schema.ts`, `packages/core/src/db/repo.ts`, `packages/core/src/index.ts`
- Create (generated): `packages/core/drizzle/0001_*.sql` + `meta/`
- Create: `apps/worker/src/people.ts`
- Modify: `apps/worker/src/routes/slack.ts`, `apps/worker/test/helpers.ts`
- Test: `packages/core/src/slack/client.test.ts`, `packages/core/src/slack/fake.test.ts`, `packages/core/src/db/repo.test.ts`, `apps/worker/test/people.test.ts`

**Interfaces:**
- Consumes: `SlackClient`, `RealSlackClient`, `FakeSlackClient`, `SlackApiError`, `ensurePerson`, `getPerson`, `open`, `Deps`.
- Produces: `UserProfile = { displayName: string; tz: string }`; `SlackClient.getUserInfo({ botToken, userId }): Promise<UserProfile | null>`; `FakeSlackClient.users: Map<string, UserProfile>` and `userInfoCalls: string[]`; `people.profileSyncedAt: number | null`; `updatePersonProfile(db, id, { displayName, tz, profileSyncedAt }): Promise<PersonRow>`; `personForSlackUser(deps, workspace, slackUserId, fallbackName): Promise<PersonRow>`; `PROFILE_MAX_AGE_MS = 86_400_000`; `seedWorkspace(deps, { withUserToken?, profileSynced? })`.

- [ ] **Step 1: Failing client and fake tests**

Append to `packages/core/src/slack/client.test.ts` inside `describe("RealSlackClient", …)` (the file already has `fetchReturning(body, status)` and imports `vi`, `RealSlackClient`, `SlackApiError`):
```ts
  it("reads a user's display name and time zone with the bot token", async () => {
    const fetchFn = fetchReturning({
      ok: true,
      user: { name: "dana", real_name: "Dana Levi", tz: "Asia/Jerusalem", profile: { display_name: "Dana" } },
    });
    const slack = new RealSlackClient(fetchFn);
    expect(await slack.getUserInfo({ botToken: "xoxb-1", userId: "U1" })).toEqual({
      displayName: "Dana",
      tz: "Asia/Jerusalem",
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/users.info?user=U1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
  });

  it("returns null for an unknown user and falls back to UTC and the id when fields are missing", async () => {
    const unknown = new RealSlackClient(fetchReturning({ ok: false, error: "user_not_found" }));
    expect(await unknown.getUserInfo({ botToken: "x", userId: "U9" })).toBeNull();
    const bare = new RealSlackClient(fetchReturning({ ok: true, user: {} }));
    expect(await bare.getUserInfo({ botToken: "x", userId: "U9" })).toEqual({ displayName: "U9", tz: "UTC" });
  });

  it("turns a non-JSON reply into a typed error instead of a SyntaxError", async () => {
    const fetchFn = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(new RealSlackClient(fetchFn).clearUserStatus({ userToken: "t" })).rejects.toEqual(
      new SlackApiError("users.profile.set", "http_502"),
    );
  });
```

Append to `packages/core/src/slack/fake.test.ts` inside `describe("FakeSlackClient", …)`:
```ts
  it("answers users.info from its seeded users and records the calls", async () => {
    const slack = new FakeSlackClient();
    slack.users.set("U1", { displayName: "Dana", tz: "Asia/Jerusalem" });
    expect(await slack.getUserInfo({ botToken: "b", userId: "U1" })).toEqual({
      displayName: "Dana",
      tz: "Asia/Jerusalem",
    });
    expect(await slack.getUserInfo({ botToken: "b", userId: "U2" })).toBeNull();
    expect(slack.userInfoCalls).toEqual(["U1", "U2"]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/core/src/slack`
Expected: FAIL — `getUserInfo is not a function` / `users` undefined; the non-JSON test fails with a SyntaxError instead of `SlackApiError`.

- [ ] **Step 3: Implement the client and the fake**

In `packages/core/src/slack/client.ts`:

Add after the `SetStatusArgs` type:
```ts
export type UserProfile = { displayName: string; tz: string };

type SlackUser = {
  name?: string;
  real_name?: string;
  tz?: string;
  profile?: { display_name?: string; real_name?: string };
};
```

Add to the `SlackClient` interface:
```ts
  /** The person's display name and IANA time zone, or null when Slack doesn't know the user. */
  getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null>;
```

Add after `type ApiResponse = …`:
```ts
/** Slack answers JSON; an edge or outage page is not Slack and becomes a typed error. */
async function parseJson(res: Response, method: string): Promise<ApiResponse> {
  try {
    return (await res.json()) as ApiResponse;
  } catch {
    throw new SlackApiError(method, `http_${res.status}`);
  }
}
```

In `RealSlackClient.call`, replace `const data = (await res.json()) as ApiResponse;` with `const data = await parseJson(res, method);`.

Add to `RealSlackClient`:
```ts
  async getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", args.userId);
    const res = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${args.botToken}` },
    });
    const data = await parseJson(res, "users.info");
    if (!data.ok) {
      if (data.error === "user_not_found") return null;
      throw new SlackApiError("users.info", data.error ?? "unknown_error");
    }
    const user = (data.user ?? {}) as SlackUser;
    const displayName =
      user.profile?.display_name ||
      user.profile?.real_name ||
      user.real_name ||
      user.name ||
      args.userId;
    return { displayName, tz: user.tz || "UTC" };
  }
```

In `packages/core/src/slack/fake.ts`: change the import line to also bring `type UserProfile` from `./client`, add two fields after `statuses`:
```ts
  /** Seed with `users.set(slackUserId, { displayName, tz })`; unknown users answer null like Slack does. */
  users = new Map<string, UserProfile>();
  userInfoCalls: string[] = [];
```
and the method:
```ts
  async getUserInfo(args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    this.maybeFail("getUserInfo");
    this.userInfoCalls.push(args.userId);
    return this.users.get(args.userId) ?? null;
  }
```

In `packages/core/src/index.ts` change the client type export line to:
```ts
export type { RespondArgs, SetStatusArgs, SlackClient, UserProfile } from "./slack/client";
```

Run: `pnpm exec vitest run packages/core/src/slack`
Expected: PASS (including the three new client tests and the fake test).

- [ ] **Step 4: Schema, migration, repo**

In `packages/core/src/db/schema.ts`, in the `people` table add after `userTokenSealed`:
```ts
    /** When the display name and tz were last read from Slack; null until the first read. */
    profileSyncedAt: integer("profile_synced_at"),
```

Run: `pnpm --filter @steward/core db:generate`
Expected: `packages/core/drizzle/0001_<name>.sql` containing `ALTER TABLE \`people\` ADD \`profile_synced_at\` integer;` and an updated `meta/`.

Append to `packages/core/src/db/repo.test.ts` inside `describe("repo", …)` (add `updatePersonProfile` to the import from `./repo`):
```ts
  it("updates a person's profile from Slack and records when", async () => {
    const person = await ensurePerson(db, "T1", "U1", "U1");
    expect(person.profileSyncedAt).toBeNull();
    const updated = await updatePersonProfile(db, person.id, {
      displayName: "Dana",
      tz: "Asia/Jerusalem",
      profileSyncedAt: 5_000,
    });
    expect(updated).toMatchObject({ displayName: "Dana", tz: "Asia/Jerusalem", profileSyncedAt: 5_000 });
  });
```

Run: `pnpm exec vitest run packages/core/src/db/repo.test.ts`
Expected: FAIL — `updatePersonProfile` is not exported.

In `packages/core/src/db/repo.ts`: in `ensurePerson`'s `row` literal add `profileSyncedAt: null,` after `userTokenSealed: null,`; append:
```ts
export async function updatePersonProfile(
  db: Db,
  id: string,
  profile: { displayName: string; tz: string; profileSyncedAt: number },
): Promise<PersonRow> {
  await db.update(people).set(profile).where(eq(people.id, id));
  const row = await getPerson(db, id);
  if (!row) throw new Error(`person ${id} not found`);
  return row;
}
```
In `packages/core/src/index.ts` add `updatePersonProfile,` to the `./db/repo` export list (alphabetical: after `setPersonUserToken`).

Run: `pnpm exec vitest run packages/core`
Expected: all core tests PASS.

- [ ] **Step 5: Failing worker flow tests**

Replace `seedWorkspace` in `apps/worker/test/helpers.ts` with:
```ts
export async function seedWorkspace(
  deps: TestDeps,
  opts: { withUserToken?: boolean; profileSynced?: boolean } = {},
): Promise<PersonRow> {
  const { withUserToken = true, profileSynced = true } = opts;
  await upsertWorkspace(deps.db, {
    id: "T1",
    name: "Acme",
    botTokenSealed: await seal(deps.tokenKey, "xoxb-bot"),
    botUserId: "UBOT",
    installedAt: NOW - 1000,
  });
  let person = await ensurePerson(deps.db, "T1", "U_DANA", "dana");
  if (profileSynced) {
    await deps.db
      .update(schema.people)
      .set({ tz: TZ, profileSyncedAt: NOW })
      .where(eq(schema.people.id, person.id));
    person = { ...person, tz: TZ, profileSyncedAt: NOW };
  }
  if (withUserToken)
    person = await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, "xoxp-dana"));
  return person;
}
```
(Existing callers pass `{ withUserToken: false }` — still valid.)

Create `apps/worker/test/people.test.ts`:
```ts
import { getPerson } from "@steward/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { NOW, seedWorkspace, slackPost, testDeps } from "./helpers";

/** 22:30 UTC on 12 Nov is already 00:30 on 13 Nov in Asia/Jerusalem. */
const LATE = Date.UTC(2026, 10, 12, 22, 30);

const ooo = (nowMs: number) => ({
  command: "/ooo",
  text: "",
  team_id: "T1",
  user_id: "U_DANA",
  user_name: "dana",
  trigger_id: `trig-${nowMs}`,
  response_url: "https://hooks.slack.com/commands/T1/1/r1",
});

function initialFromDate(deps: ReturnType<typeof testDeps>, index: number): unknown {
  const from = deps.slack.openedViews[index]?.view.blocks[1];
  return from?.type === "input" && from.element.type === "datepicker" ? from.element.initial_date : undefined;
}

describe("person profile from Slack", () => {
  it("reads time zone and name on first contact and uses the person's today for the form", async () => {
    const deps = testDeps({ now: () => LATE });
    const app = createApp(deps);
    await seedWorkspace(deps, { profileSynced: false });
    deps.slack.users.set("U_DANA", { displayName: "Dana Levi", tz: "Asia/Jerusalem" });

    const res = await slackPost(app, "/slack/commands", ooo(LATE), LATE);
    expect(res.status).toBe(200);
    expect(initialFromDate(deps, 0)).toBe("2026-11-13");
    expect(await getPerson(deps.db, "T1:U_DANA")).toMatchObject({
      tz: "Asia/Jerusalem",
      displayName: "Dana Levi",
      profileSyncedAt: LATE,
    });
    expect(deps.slack.userInfoCalls).toEqual(["U_DANA"]);
  });

  it("does not ask Slack again within a day, and keeps what it has when Slack fails", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await seedWorkspace(deps);

    await slackPost(app, "/slack/commands", ooo(NOW), NOW);
    expect(deps.slack.userInfoCalls).toEqual([]);

    deps.clock.now = NOW + 25 * 60 * 60 * 1000;
    deps.slack.failNext.getUserInfo = "ratelimited";
    const res = await slackPost(app, "/slack/commands", ooo(deps.clock.now), deps.clock.now);
    expect(res.status).toBe(200);
    expect(deps.slack.openedViews).toHaveLength(2);
    expect((await getPerson(deps.db, "T1:U_DANA"))?.tz).toBe("Asia/Jerusalem");
  });

  it("falls back to UTC and the Slack handle when Slack doesn't know the user", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await seedWorkspace(deps, { profileSynced: false });
    await slackPost(app, "/slack/commands", ooo(NOW), NOW);
    expect(await getPerson(deps.db, "T1:U_DANA")).toMatchObject({
      tz: "UTC",
      displayName: "dana",
      profileSyncedAt: null,
    });
    expect(initialFromDate(deps, 0)).toBe("2026-11-12");
  });
});
```

Run: `pnpm exec vitest run apps/worker/test/people.test.ts`
Expected: FAIL — the first test finds `profileSyncedAt` null and `userInfoCalls` empty (nothing calls Slack yet).

- [ ] **Step 6: `personForSlackUser` and the route change**

Create `apps/worker/src/people.ts`:
```ts
import {
  ensurePerson,
  open,
  type PersonRow,
  updatePersonProfile,
  type WorkspaceRow,
} from "@steward/core";
import type { Deps } from "./deps";

/** How long a person's Slack profile (time zone, display name) is trusted before it is read again. */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The person row for a Slack user. Their time zone and display name are read from Slack on first
 * contact and refreshed once a day; a failed or empty read keeps what is stored.
 */
export async function personForSlackUser(
  deps: Deps,
  workspace: WorkspaceRow,
  slackUserId: string,
  fallbackName: string,
): Promise<PersonRow> {
  const person = await ensurePerson(deps.db, workspace.id, slackUserId, fallbackName);
  const now = deps.now();
  if (person.profileSyncedAt !== null && now - person.profileSyncedAt < PROFILE_MAX_AGE_MS) {
    return person;
  }
  try {
    const botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    const profile = await deps.slack.getUserInfo({ botToken, userId: slackUserId });
    if (!profile) return person;
    return await updatePersonProfile(deps.db, person.id, { ...profile, profileSyncedAt: now });
  } catch (err) {
    console.error("users.info failed; keeping the stored profile", { person: person.id, err });
    return person;
  }
}
```

In `apps/worker/src/routes/slack.ts`:
- In the `@steward/core` import, remove `ensurePerson`.
- Add `import { personForSlackUser } from "../people";` after the `Deps` import.
- In `/commands`, replace the `const person = await ensurePerson(…)` statement with:
  ```ts
    const person = await personForSlackUser(deps, workspace, userId, form.get("user_name") ?? userId);
  ```
- In `personAndToken`, replace the `const person = await ensurePerson(…)` statement with:
  ```ts
      const person = await personForSlackUser(
        deps,
        workspace,
        payload.user.id,
        payload.user.username ?? payload.user.name ?? payload.user.id,
      );
  ```

Run: `pnpm exec vitest run apps/worker && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green — 3 new people tests, the existing 16 worker tests, 65 → 73 overall (3 client + 1 fake + 1 repo + 3 people).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: read each person's time zone and name from Slack on first contact, refreshed daily

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 2: Honest about scheduling — the reader validates against the person's today

**Files:**
- Modify: `packages/availability/src/status/form.ts`, `apps/worker/src/routes/slack.ts`
- Test: `packages/availability/src/status/form.test.ts`, `apps/worker/test/ooo.test.ts`

**Interfaces:**
- Consumes: `todayIn`, `personForSlackUser` (Task 1).
- Produces: `readStatusSubmission(view, opts: { today: string }): ReadResult` — new second parameter; error texts: from in the future → `"Scheduling arrives in a later version — for now, the first day is today."`; unreal date → `"That date doesn't exist."`; last day in the past → `"The last day has already passed."`; text over 100 chars → `"Keep the status text under 100 characters."`; emoji not `:name:` → `"Write the emoji the way Slack does, like :palm_tree:."`.

- [ ] **Step 1: Failing form tests**

In `packages/availability/src/status/form.test.ts`, change every `readStatusSubmission(values(…))` call to `readStatusSubmission(values(…), { today: "2026-11-12" })`, and add inside `describe("readStatusSubmission", …)`:
```ts
  const today = { today: "2026-11-12" };

  it("refuses a first day in the future until scheduling exists", () => {
    const r = readStatusSubmission(values({ type: "out", from: "2026-11-13", to: "2026-11-14" }), today);
    expect(r).toEqual({
      ok: false,
      errors: { from: "Scheduling arrives in a later version — for now, the first day is today." },
    });
  });

  it("accepts today as the first day and a last day in the future", () => {
    const r = readStatusSubmission(values({ type: "out", from: "2026-11-12", to: "2026-11-20" }), today);
    expect(r.ok).toBe(true);
  });

  it("rejects dates that don't exist and last days already past", () => {
    const unreal = readStatusSubmission(values({ type: "out", from: "2026-11-12", to: "2026-02-30" }), today);
    expect(!unreal.ok && unreal.errors.to).toBe("That date doesn't exist.");
    const past = readStatusSubmission(values({ type: "out", from: "2026-11-10", to: "2026-11-11" }), today);
    expect(!past.ok && past.errors.to).toBe("The last day has already passed.");
  });

  it("caps the status text at 100 characters and wants a Slack-shaped emoji", () => {
    const long = readStatusSubmission(
      values({ type: "out", from: "2026-11-12", to: "2026-11-12", text: "x".repeat(101) }),
      today,
    );
    expect(!long.ok && long.errors.text).toBe("Keep the status text under 100 characters.");
    const emoji = readStatusSubmission(
      values({ type: "out", from: "2026-11-12", to: "2026-11-12", emoji: "🌴" }),
      today,
    );
    expect(!emoji.ok && emoji.errors.emoji).toBe("Write the emoji the way Slack does, like :palm_tree:.");
    const fine = readStatusSubmission(
      values({ type: "out", from: "2026-11-12", to: "2026-11-12", emoji: ":palm_tree:" }),
      today,
    );
    expect(fine.ok).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run packages/availability/src/status/form.test.ts`
Expected: FAIL — the new error messages are not produced (the future-date case returns `ok: true`).

- [ ] **Step 3: Implement the reader**

In `packages/availability/src/status/form.ts`, replace everything from `const DATE = …` to the end of the file with:
```ts
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMOJI = /^:[a-z0-9_+'-]+:$/;
const MAX_TEXT = 100;

function isStatusType(v: string): v is StatusType {
  return (STATUS_TYPES as readonly string[]).includes(v);
}

/** True for a real calendar date in YYYY-MM-DD form (2026-02-30 is not one). */
function isRealDate(d: string): boolean {
  if (!DATE.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10) === d;
}

/**
 * Reads the submitted form. `today` is the person's local date: statuses must start today until
 * scheduling arrives (Plan 3), and the last day may not already be over.
 */
export function readStatusSubmission(view: SubmittedView, opts: { today: string }): ReadResult {
  const node = (block: string): ValueNode | undefined => view.state.values[block]?.[block];
  const type = node(FIELD.type)?.selected_option?.value ?? "";
  const from = node(FIELD.from)?.selected_date ?? "";
  const to = node(FIELD.to)?.selected_date ?? "";
  const rawText = (node(FIELD.text)?.value ?? "").trim();
  const rawEmoji = (node(FIELD.emoji)?.value ?? "").trim();

  const errors: Record<string, string> = {};
  if (!isStatusType(type)) errors[FIELD.type] = "Pick what's happening";
  if (!DATE.test(from)) errors[FIELD.from] = "Pick a start date";
  else if (!isRealDate(from)) errors[FIELD.from] = "That date doesn't exist.";
  else if (from > opts.today)
    errors[FIELD.from] = "Scheduling arrives in a later version — for now, the first day is today.";
  if (!DATE.test(to)) errors[FIELD.to] = "Pick an end date";
  else if (!isRealDate(to)) errors[FIELD.to] = "That date doesn't exist.";
  else if (to < opts.today) errors[FIELD.to] = "The last day has already passed.";
  else if (DATE.test(from) && to < from) errors[FIELD.to] = "The last day can't be before the first";
  if (rawText.length > MAX_TEXT) errors[FIELD.text] = "Keep the status text under 100 characters.";
  if (rawEmoji && !EMOJI.test(rawEmoji))
    errors[FIELD.emoji] = "Write the emoji the way Slack does, like :palm_tree:.";
  if (!isStatusType(type) || Object.keys(errors).length > 0) return { ok: false, errors };

  const defaults = STATUS_DEFAULTS[type];
  const text = rawText || defaults.text;
  const emoji = rawEmoji || defaults.emoji;
  let meta: ModalMeta = { responseUrl: "" };
  try {
    meta = {
      responseUrl: "",
      ...(JSON.parse(view.private_metadata ?? "{}") as Partial<ModalMeta>),
    };
  } catch {
    // malformed metadata: keep the empty response_url and still save
  }
  return { ok: true, input: { type, from, to, text, emoji }, meta };
}
```

Run: `pnpm exec vitest run packages/availability/src/status/form.test.ts`
Expected: PASS.

- [ ] **Step 4: The route resolves the person before validating**

Replace the whole `view_submission` branch in `apps/worker/src/routes/slack.ts` (from `if (payload.type === "view_submission") {` to its closing `}` before the `block_actions` branch) with:
```ts
    if (payload.type === "view_submission") {
      const { view } = payload as ViewSubmissionPayload;
      if (view.callback_id !== STATUS_MODAL_CALLBACK) return c.text("");
      // "Today" is the person's, not UTC's, so the person is resolved before validation. The user token is not.
      const person = await personForSlackUser(
        deps,
        workspace,
        payload.user.id,
        payload.user.username ?? payload.user.name ?? payload.user.id,
      );
      const read = readStatusSubmission(view, { today: todayIn(person.tz, deps.now()) });
      if (!read.ok) return c.json({ response_action: "errors", errors: read.errors });
      const responseUrl = read.meta.responseUrl;
      deps.defer(
        (async () => {
          let saved: Awaited<ReturnType<typeof saveStatus>>;
          try {
            const userToken = person.userTokenSealed
              ? await open(deps.tokenKey, person.userTokenSealed)
              : null;
            saved = await saveStatus(availability, person, read.input, userToken);
          } catch (err) {
            await tellUser(
              responseUrl,
              `Your status didn't save — ${errorMessage(err)}. Please try again.`,
            );
            return;
          }
          try {
            if (responseUrl) {
              const card = resultCard({ ...saved, tz: person.tz, now: deps.now() });
              await deps.slack.respond({ responseUrl, ...card });
            }
          } catch {
            // The status is saved; a lost receipt is not worth a misleading message.
          }
        })(),
      );
      return c.json({ response_action: "clear" });
    }
```
(The `block_actions` branch keeps using `personAndToken`; Task 3 reshapes both.)

Add to `apps/worker/test/ooo.test.ts` inside `describe("/ooo", …)`:
```ts
  it("refuses a first day in the future with a plain field error, before saving anything", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-13", to: "2026-11-14" })),
    });
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { from: "Scheduling arrives in a later version — for now, the first day is today." },
    });
    expect(deps.deferred).toHaveLength(0);
    expect(deps.slack.statuses.size).toBe(0);
  });
```

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (74 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(availability): validate the form against the person's today; refuse future starts until scheduling exists

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 3: Hardening — trusted receipt URLs, plain failure sentences with logs, payload guards, honest OAuth edges, tenant-scoped lookups, idempotent `ensurePerson`

**Files:**
- Modify: `packages/core/src/slack/client.ts`, `packages/core/src/slack/fake.ts`, `packages/core/src/index.ts`, `packages/core/src/db/repo.ts`, `packages/availability/src/status/service.ts`, `apps/worker/src/routes/slack.ts`, `apps/worker/src/routes/oauth.ts`
- Test: `packages/core/src/slack/client.test.ts`, `packages/core/src/slack/fake.test.ts`, `packages/core/src/db/repo.test.ts`, `packages/availability/src/status/service.test.ts`, `apps/worker/test/ooo.test.ts`, `apps/worker/test/oauth.test.ts`

**Interfaces:**
- Produces: `assertTrustedResponseUrl(url: string): void` (throws `SlackApiError("response_url", "untrusted_url")`), used by both clients' `respond`; `SAVE_FAILED = "Your status didn't save. Please try again in a moment."` and `UNDO_FAILED = "Undo didn't go through. Please try again in a moment."` exported from `routes/slack.ts`; `getStatus(db, id, workspaceId)`.

- [ ] **Step 1: Failing tests**

Append to `packages/core/src/slack/client.test.ts` inside `describe("RealSlackClient", …)`:
```ts
  it("refuses to post a receipt anywhere but hooks.slack.com", async () => {
    const fetchFn = fetchReturning({}, 200);
    const slack = new RealSlackClient(fetchFn);
    await expect(slack.respond({ responseUrl: "https://evil.example/x", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    await expect(slack.respond({ responseUrl: "http://hooks.slack.com/x", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    await expect(slack.respond({ responseUrl: "not a url", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    expect(fetchFn.mock.calls).toHaveLength(0);
  });
```
Append to `packages/core/src/slack/fake.test.ts`:
```ts
  it("checks response_url the way the real client does", async () => {
    const slack = new FakeSlackClient();
    await expect(slack.respond({ responseUrl: "https://evil.example/x", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    expect(slack.responses).toHaveLength(0);
  });
```
Append to `packages/core/src/db/repo.test.ts` (add `import { eq } from "drizzle-orm";` and `import * as schema from "./schema";` at the top if not present):
```ts
  it("ensurePerson tolerates two first calls at once", async () => {
    const [a, b] = await Promise.all([
      ensurePerson(db, "T1", "U7", "Noa"),
      ensurePerson(db, "T1", "U7", "Noa"),
    ]);
    expect(a.id).toBe("T1:U7");
    expect(b.id).toBe("T1:U7");
    const rows = await db.select().from(schema.people).where(eq(schema.people.id, "T1:U7"));
    expect(rows).toHaveLength(1);
  });
```

Append to `packages/availability/src/status/service.test.ts` inside the describe (add `upsertWorkspace` and `ensurePerson` to the `@steward/core` import if missing):
```ts
  it("a status from another workspace is not yours", async () => {
    const saved = await saveStatus(
      deps, dana, { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" }, "xoxp-dana",
    );
    await upsertWorkspace(db, { id: "T2", name: "Other", botTokenSealed: "x", botUserId: "UB2", installedAt: 0 });
    const stranger = await ensurePerson(db, "T2", "U_DANA", "Dana");
    expect(await undoStatus(deps, saved.status.id, stranger, "xoxp-other")).toEqual({
      error: "That status isn't yours or no longer exists.",
    });
  });
```

In `apps/worker/test/ooo.test.ts`:
- Change the `RESPONSE_URL` constant to `"https://hooks.slack.com/commands/T1/1/r1"`.
- Import `SAVE_FAILED, UNDO_FAILED` from `"../src/routes/slack"` and change the two assertions `toMatch(/^Your status didn't save — /)` → `toBe(SAVE_FAILED)` and `toMatch(/^Undo didn't go through — /)` → `toBe(UNDO_FAILED)` (in the tests "a save that throws is reported honestly" and "an undo that throws is reported honestly").
- Add (imports needed: `schema` from `@steward/core`, `eq` from `drizzle-orm`, if not already there):
```ts
  it("ignores a malformed interaction payload with a 200 and no work", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", { payload: "not json" });
    expect(res.status).toBe(200);
    expect(deps.deferred).toHaveLength(0);
    const noUser = await slackPost(app, "/slack/interactions", { payload: JSON.stringify({ type: "x" }) });
    expect(noUser.status).toBe(200);
  });

  it("answers /ooo plainly when the workspace's bot token can't be read", async () => {
    await seedWorkspace(deps);
    await deps.db
      .update(schema.workspaces)
      .set({ botTokenSealed: "not-a-sealed-token" })
      .where(eq(schema.workspaces.id, "T1"));
    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo", text: "", team_id: "T1", user_id: "U_DANA", user_name: "dana", trigger_id: "t", response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("can't reach Slack for this workspace");
    expect(deps.slack.openedViews).toHaveLength(0);
  });
```

In `apps/worker/test/oauth.test.ts` add inside the describe:
```ts
  it("tells the person plainly when they cancelled the install", async () => {
    const deps = testDeps();
    const res = await createApp(deps).request("/oauth/slack/callback?error=access_denied");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Install cancelled");
  });

  it("reports a Slack outage during the exchange as a plain 502, not a crash", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=c&state=${state}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Slack didn't answer the install request. Try again in a minute.");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test`
Expected: the new tests FAIL (untrusted URLs are posted, `SAVE_FAILED` is not exported, a malformed payload throws → 500, the cancel path returns 400, the outage path throws, the cross-workspace undo succeeds, `ensurePerson` throws a UNIQUE error on the second insert).

- [ ] **Step 3: Core — trusted URL check, idempotent ensurePerson**

In `packages/core/src/slack/client.ts` add after `SlackApiError`:
```ts
/** Slack's response_url values live on hooks.slack.com; anything else is not Slack and gets nothing. */
export function assertTrustedResponseUrl(responseUrl: string): void {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new SlackApiError("response_url", "untrusted_url");
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") {
    throw new SlackApiError("response_url", "untrusted_url");
  }
}
```
and make `RealSlackClient.respond` start with `assertTrustedResponseUrl(args.responseUrl);`. In `fake.ts`, import `assertTrustedResponseUrl` from `./client` and make `FakeSlackClient.respond` call it first (before `maybeFail`). Export it from `packages/core/src/index.ts` next to `RealSlackClient, SlackApiError`.

In `packages/core/src/db/repo.ts`, replace the end of `ensurePerson` (the `await db.insert(...)` and `return row;` lines) with:
```ts
  await db.insert(people).values(row).onConflictDoNothing();
  return (await getPerson(db, id)) ?? row;
```

- [ ] **Step 4: Availability — workspace-scoped status lookup**

In `packages/availability/src/status/service.ts` replace `getStatus` with:
```ts
export async function getStatus(db: Db, id: string, workspaceId: string): Promise<StatusRow | null> {
  const rows = await db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.id, id), eq(schema.statuses.workspaceId, workspaceId)));
  return rows[0] ?? null;
}
```
and in `undoStatus` call `getStatus(deps.db, statusId, person.workspaceId)`.

- [ ] **Step 5: Worker — guards, fixed sentences, logs**

In `apps/worker/src/routes/slack.ts`:
- Remove the `errorMessage` helper and add, exported, after the imports:
  ```ts
  export const SAVE_FAILED = "Your status didn't save. Please try again in a moment.";
  export const UNDO_FAILED = "Undo didn't go through. Please try again in a moment.";
  const BOT_TOKEN_UNREADABLE =
    "Steward can't reach Slack for this workspace right now. Ask whoever installed it to reinstall Steward.";
  ```
- In `/commands`, replace `const botToken = await open(deps.tokenKey, workspace.botTokenSealed);` with:
  ```ts
    let botToken: string;
    try {
      botToken = await open(deps.tokenKey, workspace.botTokenSealed);
    } catch (err) {
      console.error("bot token unreadable", { workspace: workspace.id, err });
      return c.text(BOT_TOKEN_UNREADABLE);
    }
  ```
- In `/interactions`, replace the `const payload = JSON.parse(…) as InteractionPayload;` statement with:
  ```ts
    let payload: InteractionPayload;
    try {
      payload = JSON.parse(new URLSearchParams(c.get("rawBody")).get("payload") ?? "") as InteractionPayload;
    } catch {
      return c.text(""); // not a Slack payload; nothing to act on
    }
    if (!payload || typeof payload !== "object" || !payload.team?.id || !payload.user?.id) return c.text("");
  ```
- Replace `tellUser` with:
  ```ts
    const tellUser = async (responseUrl: string | undefined, text: string) => {
      if (!responseUrl) return;
      try {
        await deps.slack.respond({ responseUrl, text });
      } catch (err) {
        console.error("could not tell the user", { err });
      }
    };
  ```
- In the `view_submission` deferred work: the catch becomes
  ```ts
          } catch (err) {
            console.error("save failed", { person: person.id, err });
            await tellUser(responseUrl, SAVE_FAILED);
            return;
          }
  ```
  and the receipt catch becomes `} catch (err) { console.error("receipt not delivered", { person: person.id, err }); }`.
- Replace the whole `block_actions` branch with:
  ```ts
    if (payload.type === "block_actions") {
      const { actions, response_url } = payload as BlockActionsPayload;
      const action = actions[0];
      if (action?.action_id === UNDO_ACTION && action.value && response_url) {
        const statusId = action.value;
        deps.defer(
          (async () => {
            let person: PersonRow;
            let result: Awaited<ReturnType<typeof undoStatus>>;
            try {
              person = await personForSlackUser(
                deps,
                workspace,
                payload.user.id,
                payload.user.username ?? payload.user.name ?? payload.user.id,
              );
              const userToken = person.userTokenSealed
                ? await open(deps.tokenKey, person.userTokenSealed)
                : null;
              result = await undoStatus(availability, statusId, person, userToken);
            } catch (err) {
              console.error("undo failed", { status: statusId, err });
              await tellUser(response_url, UNDO_FAILED);
              return;
            }
            try {
              if ("error" in result) {
                await deps.slack.respond({ responseUrl: response_url, text: result.error });
              } else {
                const card = resultCard({ ...result, tz: person.tz, now: deps.now() });
                await deps.slack.respond({ responseUrl: response_url, ...card, replaceOriginal: true });
              }
            } catch (err) {
              console.error("receipt not delivered", { status: statusId, err });
            }
          })(),
        );
      }
      return c.text("");
    }
  ```
  and delete the now-unused `personAndToken` helper. Add `type PersonRow` to the `@steward/core` import.

In `apps/worker/src/routes/oauth.ts`, replace the start of the callback handler through the `const data = …` line with:
```ts
  r.get("/slack/callback", async (c) => {
    const denied = c.req.query("error");
    if (denied) {
      return c.html(
        `<!doctype html><title>Steward not installed</title><p>Install cancelled (${escapeHtml(denied)}). Nothing was changed.</p>`,
      );
    }
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    if (!code || !(await verifyState(deps.signingSecret, state, Math.floor(deps.now() / 1000)))) {
      return c.text("This install link has expired. Start again from the product page.", 400);
    }
    let data: AccessResponse;
    try {
      const res = await deps.fetchFn("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: deps.slackClientId,
          client_secret: deps.slackClientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      data = (await res.json()) as AccessResponse;
    } catch (err) {
      console.error("oauth.v2.access failed", { err });
      return c.text("Slack didn't answer the install request. Try again in a minute.", 502);
    }
```
(the rest of the handler — the `!data.ok` check onward — is unchanged).

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (82 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix: trusted receipt URLs, plain failure sentences with logs, payload and token guards, honest OAuth edges, workspace-scoped undo, idempotent ensurePerson

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 4: Real-driver smoke test on D1 (Miniflare)

**Files:**
- Modify: `packages/core/package.json`, `packages/core/tsconfig.json`
- Test: `packages/core/src/db/d1.smoke.test.ts`

**Interfaces:**
- Consumes: the migration SQL files in `packages/core/drizzle/`, `drizzle-orm/d1`, the repo and engine.
- Produces: proof that the `Db` cast and the engine's queries run on the real D1 driver.

- [ ] **Step 1: Add Miniflare and the Workers types**

Run: `pnpm --filter @steward/core add -D miniflare@^4 @cloudflare/workers-types@^4.20251001.0`
Expected: both in `packages/core/package.json` devDependencies; lockfile updated. In `packages/core/tsconfig.json` set `"types": ["node", "@cloudflare/workers-types"]`. Run `pnpm exec tsc --noEmit -p packages/core` — if the two type sets clash, keep `["node"]`, and in the test below replace `D1Database` with `Parameters<typeof drizzle>[0]`.

- [ ] **Step 2: The smoke test**

Create `packages/core/src/db/d1.smoke.test.ts`:
```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Connector, ConnectorRegistry, type WriteSpec } from "../engine/connector";
import { createTargets, executeTargets, undoTargets } from "../engine/engine";
import type { Db } from "./client";
import { ensurePerson, getPerson, upsertWorkspace } from "./repo";
import * as schema from "./schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../drizzle");

/** Applies the committed migrations statement by statement, the way `wrangler d1 migrations apply` does. */
async function applyMigrations(d1: D1Database): Promise<void> {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const raw of sql.split("--> statement-breakpoint")) {
      const statement = raw.replace(/\s+/g, " ").trim();
      if (statement) await d1.prepare(statement).run();
    }
  }
}

describe("D1 driver smoke (Miniflare)", () => {
  let mf: Miniflare;
  let db: Db;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "steward-smoke" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyMigrations(d1);
    db = drizzle(d1, { schema }) as unknown as Db;
  }, 90_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("runs the repo and the engine against the real D1 driver", async () => {
    await upsertWorkspace(db, {
      id: "T1", name: "Acme", botTokenSealed: "sealed", botUserId: "UB", installedAt: 1,
    });
    const person = await ensurePerson(db, "T1", "U1", "Dana");
    expect((await getPerson(db, person.id))?.tz).toBe("UTC");

    await db.insert(schema.statuses).values({
      id: "S1", workspaceId: "T1", personId: person.id, type: "out", startMs: 1, endMs: 2, text: "Out",
      emoji: ":x:", state: "active", source: "form", createdAt: 0, undoUntilMs: null, replacedStatusId: null,
    });
    const seen: string[] = [];
    const connector: Connector = {
      system: "a",
      async perform(_spec, ctx) {
        seen.push(ctx.idempotencyKey);
        return { externalId: "ext-1" };
      },
      async undo(externalId) {
        seen.push(`undo:${externalId}`);
      },
    };
    const registry = new ConnectorRegistry().register(connector);
    const actor = { workspaceId: "T1", personId: person.id, userToken: null };
    const specs: WriteSpec[] = [{ system: "a", op: "set", args: { v: 1 } }];
    const created = await createTargets(db, "S1", specs);
    const done = await executeTargets(db, registry, actor, created, () => 5);
    expect(done.map((t) => [t.state, t.externalId, t.attempts])).toEqual([["done", "ext-1", 1]]);
    const undone = await undoTargets(db, registry, actor, done, () => 6);
    expect(undone.map((t) => t.state)).toEqual(["undone"]);
    expect(seen).toEqual(["S1:a:set", "undo:ext-1"]);
    const auditRows = await db.select().from(schema.audit);
    expect(auditRows.map((r) => `${r.action}:${r.result}`)).toEqual(["a.set:done", "a.set.undo:undone"]);
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm exec vitest run packages/core/src/db/d1.smoke.test.ts`
Expected: PASS (the first run starts workerd; allow a minute). If Miniflare cannot start on this machine, report BLOCKED with the exact error instead of weakening the test.

Then: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (83 tests).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(core): smoke the repo and engine on the real D1 driver with Miniflare

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 5: Deploy runbook, Slack app manifest, `.gitattributes`, secret-gated CI deploy

**Files:**
- Create: `apps/worker/slack-manifest.json`, `.gitattributes`
- Modify: `README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a manifest the owner pastes into Slack's "Create app from manifest" after replacing `APP_HOST`; a README section that is the complete first-deploy procedure; a `deploy` job that runs only on `main` and only when `CLOUDFLARE_API_TOKEN` is set.

- [ ] **Step 1: Manifest and attributes**

Create `apps/worker/slack-manifest.json`:
```json
{
  "display_information": {
    "name": "Steward",
    "description": "Say once that you're out; Steward sets it everywhere, with a receipt and Undo.",
    "background_color": "#1f2937"
  },
  "features": {
    "bot_user": { "display_name": "Steward", "always_online": true },
    "slash_commands": [
      {
        "command": "/ooo",
        "url": "https://APP_HOST/slack/commands",
        "description": "Set your availability",
        "usage_hint": "",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "redirect_urls": ["https://APP_HOST/oauth/slack/callback"],
    "scopes": {
      "bot": ["commands", "chat:write", "users:read"],
      "user": ["users.profile:write"]
    }
  },
  "settings": {
    "interactivity": { "is_enabled": true, "request_url": "https://APP_HOST/slack/interactions" },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Create `.gitattributes`:
```
* text=auto eol=lf
```

- [ ] **Step 2: README runbook**

Insert into `README.md` before the `## Licence` heading:
```markdown
## Deploy (first time)

Everything below is done once by the account owner; CI deploys on every later push to `main`.

1. **Cloudflare.** Create an account; create an API token with *Workers Scripts: Edit* and *D1: Edit*; note the account id. Locally: `pnpm --filter @steward/worker exec wrangler login`.
2. **Database.** `pnpm --filter @steward/worker exec wrangler d1 create steward` → paste the printed `database_id` into `apps/worker/wrangler.toml`, commit. Then `pnpm --filter @steward/worker db:migrate:remote`.
3. **Slack app.** At api.slack.com/apps choose *Create New App → From an app manifest*, paste `apps/worker/slack-manifest.json` with `APP_HOST` replaced by the Worker's host (shown by `wrangler deploy`, e.g. `steward.<account>.workers.dev`). Under *Basic Information* copy the signing secret, client id and client secret. Under *Manage Distribution* enable public distribution.
4. **Secrets.** From `apps/worker`: `wrangler secret put SLACK_SIGNING_SECRET`, `wrangler secret put SLACK_CLIENT_ID`, `wrangler secret put SLACK_CLIENT_SECRET`, `wrangler secret put TOKEN_KEY` (32 random bytes, base64: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`), `wrangler secret put APP_URL` (`https://<host>`, no trailing slash).
5. **Deploy.** `pnpm --filter @steward/worker deploy`. Open `https://<host>/health` → `{"ok":true}`.
6. **Install.** Visit `https://<host>/oauth/slack/install`, approve, then type `/ooo` in Slack.
7. **CI.** Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; from then on every push to `main` applies migrations and deploys after the checks pass.

Rotating a secret: `wrangler secret put <NAME>` again. Rotating `TOKEN_KEY` invalidates every stored token (people reconnect).
```

- [ ] **Step 3: CI deploy job**

Append to `.github/workflows/ci.yml` (under `jobs:`, after `check`):
```yaml
  deploy:
    needs: check
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Skip until the Cloudflare secrets exist
        if: env.CLOUDFLARE_API_TOKEN == ''
        run: echo "No CLOUDFLARE_API_TOKEN secret; deploy skipped."
      - name: Apply migrations and deploy
        if: env.CLOUDFLARE_API_TOKEN != ''
        run: pnpm --filter @steward/worker db:migrate:remote && pnpm --filter @steward/worker deploy
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm lint && pnpm test && pnpm typecheck && pnpm --filter @steward/worker build`
Expected: green; the manifest is valid JSON (Biome checks it); the dry-run bundle still succeeds.

```bash
git add -A
git commit -m "docs: first-deploy runbook and Slack app manifest; ci: deploy on main once the Cloudflare secrets exist; LF line endings

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Self-review

**Coverage of the Plan 1 final review's pre-deploy gates:** time zones and names from Slack — Task 1; no false promise about scheduling — Task 2 (refuse future starts; the card's "⏳ will be set when it starts" line stays in code but cannot be reached until Plan 3 turns scheduling on); receipt URL pinned to `hooks.slack.com` — Task 3; `console.error` in swallowed catches and fixed user sentences — Task 3; real-driver smoke — Task 4; deploy runbook and manifest — Task 5. Plan 2 hardening items that also landed: payload guards, the unguarded `res.json()` (Task 1's `parseJson`), OAuth cancel and outage, the `ensurePerson` race, `workspace_id` on the status lookup — Task 3. Not in this plan, by design: DST gaps at local midnight (Plan 3 with the resolver), `.not.toBeNull()` test polish, the demo emulator (Plan 2b).

**Placeholder scan:** the only placeholders are `APP_HOST` in the manifest and `database_id` in `wrangler.toml`, both owner inputs documented in the runbook. Every code step shows the code.

**Type consistency:** `getUserInfo` returns `UserProfile | null` in the interface, the real client, the fake and `personForSlackUser`; `updatePersonProfile`'s argument `{ displayName, tz, profileSyncedAt }` matches the `people` columns; `readStatusSubmission(view, { today })` is called that way in the route, the form tests and the ooo tests; `getStatus(db, id, workspaceId)` is called that way in `undoStatus`; `SAVE_FAILED`/`UNDO_FAILED` are exported from `routes/slack.ts` and imported by the ooo tests; `seedWorkspace`'s options object is compatible with the existing `{ withUserToken: false }` caller; the `actor` object in the smoke test is an `ActorCtx` (no `idempotencyKey`), which is what `executeTargets`/`undoTargets` take after Plan 1's engine fix.
