# Steward · Plan 2b-i: Demo Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A demo tenant that any visitor can get in one request and drive for an hour through HTTP — the same `/ooo` → form → Save → receipt → Undo flow the Slack app runs, against a fake Slack whose state is readable — plus a time control and automatic cleanup. This is the API the browser emulator (Plan 2b-ii) will sit on.

**Architecture:** The Slack route handlers are extracted into plain functions (`handleSlashCommand`, `handleInteraction`) that the signed `/slack/*` routes and the new `/demo/*` routes both call. A demo session is a real workspace (`demo:<session>`) with three seeded people whose Slack "connections" are fake; its `SlackClient` is `DemoSlackClient`, which records every call as a row in `demo_events` instead of calling Slack. Demo requests run with a per-session clock offset and an inline `defer`, so the emulator sees the result of a call in the call's own response and in `GET /demo/:id/state`. Sessions expire after an hour; the tick deletes everything they created.

**Tech Stack:** as Plans 1–2a (TypeScript 5.9, pnpm, Hono 4, Drizzle on D1/SQLite, Vitest 3, Biome 2.6, Wrangler 4). No new dependencies.

## Global Constraints

- TypeScript end to end; ESM; `packages/*/src` and `apps/worker/src` use only web-standard APIs (Cloudflare Workers).
- The demo runs the **real** handlers and the real engine. Only the Slack client and the clock are swapped; nothing in `packages/availability` learns about the demo.
- A demo request can only ever touch its own session's workspace: the server overrides `team.id`, `user.id`, `response_url` and the view's `private_metadata` in anything the visitor sends; session ids are random UUIDs; no cross-session reads.
- Honest states everywhere (the same receipts, the same sentences); `DemoSlackClient.respond` runs `assertTrustedResponseUrl` like the real client (demo response URLs are `https://hooks.slack.com/demo/<session>`).
- Demo tokens are fixed strings (`xoxb-demo`, `xoxp-demo-<user>`), sealed with the real `TOKEN_KEY` like any other token, never special-cased in the handlers.
- Limits: a session lives `DEMO_SESSION_TTL_MS = 60 min`; at most `DEMO_MAX_LIVE_SESSIONS = 200` live sessions (429 beyond); the clock can be advanced at most 24 h ahead.
- Nothing from any employer in code, comments, fixtures or docs; fictional people Dana (you), Omer, Noa; fictional company Acme.
- Commits: conventional prefixes, one commit per task, trailer naming the Claude model that made the commit.
- Run from `C:\Users\nafta\steward`; the lint script covers `packages apps package.json tsconfig.base.json vitest.config.ts`; `biome.json` is hook-protected. Every task ends with `pnpm test`, `pnpm typecheck` (four `tsc` runs) and `pnpm lint` green.

---

## File structure

```
apps/worker/
  src/slack/handlers.ts          handleSlashCommand(deps, form), handleInteraction(deps, payload)   (extracted from routes/slack.ts)
  src/routes/slack.ts            thin: verify signature, parse, call the handler, answer
  src/demo/slackClient.ts        DemoSlackClient (records to demo_events), readDemoEvents
  src/demo/session.ts            createDemoSession, getDemoSession, advanceDemoClock, demoDeps, cleanupDemoSessions, DEMO_* constants
  src/routes/demo.ts             /demo/sessions, /demo/:id/state, /command, /interact, /advance
  src/app.ts                     mounts /demo
  src/tick.ts                    calls cleanupDemoSessions
  test/demoSlackClient.test.ts, test/demoSession.test.ts, test/demo.test.ts
packages/core/
  src/db/schema.ts               demo_sessions, demo_events
  drizzle/0002_*.sql             generated
```

---

### Task 1: Extract the Slack handlers from the routes

**Files:**
- Create: `apps/worker/src/slack/handlers.ts`
- Modify: `apps/worker/src/routes/slack.ts`
- Tests: unchanged (`apps/worker/test/ooo.test.ts`, `people.test.ts` must still pass as they are)

**Interfaces:**
- Produces, exported from `apps/worker/src/slack/handlers.ts`:
  ```ts
  /** The slash-command handler. Returns the text Slack shows the caller at once ("" for nothing). */
  export async function handleSlashCommand(deps: Deps, form: URLSearchParams): Promise<string>;
  /** What the HTTP route must answer Slack with. */
  export type InteractionAnswer = { kind: "json"; body: unknown } | { kind: "text"; body: string };
  /** The interaction handler. `rawPayload` is the decoded `payload` form field (a JSON string) or an already-parsed object. */
  export async function handleInteraction(deps: Deps, rawPayload: unknown): Promise<InteractionAnswer>;
  ```
  plus the sentences `SAVE_FAILED`, `UNDO_FAILED`, `LOOKUP_FAILED` (moved here; `routes/slack.ts` re-exports them so the existing test imports keep working).

- [ ] **Step 1: Move the bodies**

Create `apps/worker/src/slack/handlers.ts` by moving, verbatim, everything inside the two route callbacks of `apps/worker/src/routes/slack.ts` except the signature middleware:
- The `/commands` callback body becomes `handleSlashCommand(deps, form)`: where the route did `return c.text(X)`, the function does `return X`.
- The `/interactions` callback body becomes `handleInteraction(deps, rawPayload)`: the existing `JSON.parse` guard runs when `rawPayload` is a string (an object is used as is; anything else answers `{ kind: "text", body: "" }`); every `return c.json(X)` becomes `return { kind: "json", body: X }` and every `return c.text(X)` becomes `return { kind: "text", body: X }`. `deps.defer`, `tellUser`, the `availability` object and the `personForSlackUser` calls move unchanged.
- Move the module-level constants and helpers the bodies use (`SAVE_FAILED`, `UNDO_FAILED`, `LOOKUP_FAILED`, `BOT_TOKEN_UNREADABLE`, …) into `handlers.ts`; export the three sentences.

- [ ] **Step 2: Thin routes**

Replace the two route callbacks in `apps/worker/src/routes/slack.ts` with:
```ts
  r.post("/commands", async (c) => {
    const form = new URLSearchParams(c.get("rawBody"));
    return c.text(await handleSlashCommand(deps, form));
  });

  r.post("/interactions", async (c) => {
    const raw = new URLSearchParams(c.get("rawBody")).get("payload") ?? "";
    const answer = await handleInteraction(deps, raw);
    return answer.kind === "json" ? c.json(answer.body) : c.text(answer.body);
  });
```
Keep the signature middleware exactly as it is. Add near the top of `routes/slack.ts`:
```ts
import { handleInteraction, handleSlashCommand } from "../slack/handlers";
export { LOOKUP_FAILED, SAVE_FAILED, UNDO_FAILED } from "../slack/handlers";
```
and remove the imports the file no longer needs.

- [ ] **Step 3: Verify nothing changed**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: the same 95 tests pass unchanged (the flow tests drive the routes); tsc and Biome clean (`pnpm lint:fix` once for import ordering if needed).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(worker): extract the Slack handlers from the routes so the demo can call them

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 2: Demo tables and the recording Slack client

**Files:**
- Modify: `packages/core/src/db/schema.ts`, `packages/core/src/index.ts`
- Create (generated): `packages/core/drizzle/0002_*.sql` + `meta/`
- Create: `apps/worker/src/demo/slackClient.ts`
- Test: `apps/worker/test/demoSlackClient.test.ts`

**Interfaces:**
- Produces: tables `demoSessions` and `demoEvents` (below) with row types `DemoSessionRow`, `DemoEventRow`; `DemoSlackClient(db, sessionId, now)` implementing `SlackClient` and recording each call as a `demo_events` row; `readDemoEvents(db, sessionId): Promise<DemoEventRow[]>` ordered by `seq`.

- [ ] **Step 1: Schema**

Append to `packages/core/src/db/schema.ts`:
```ts
/** A visitor's hour in the demo. `id` is random; the workspace it owns is `demo:<id>`. */
export const demoSessions = sqliteTable("demo_sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  /** Added to the real clock for every request in this session (the emulator's "advance time"). */
  clockOffsetMs: integer("clock_offset_ms").notNull().default(0),
  youPersonId: text("you_person_id").notNull(),
});

/** Everything the fake Slack was asked to do, in order: `view` (views.open), `response` (response_url post), `status` (profile status set or cleared). */
export const demoEvents = sqliteTable(
  "demo_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("demo_events_session_seq_idx").on(t.sessionId, t.seq)],
);

export type DemoSessionRow = typeof demoSessions.$inferSelect;
export type DemoEventRow = typeof demoEvents.$inferSelect;
```
Add `DemoEventRow, DemoSessionRow` to the row-type export line in `packages/core/src/index.ts` (the `schema` namespace export already covers the tables).

Run: `pnpm --filter @steward/core db:generate`
Expected: `packages/core/drizzle/0002_<name>.sql` creating `demo_sessions` and `demo_events` with the index.

- [ ] **Step 2: Failing client test**

Create `apps/worker/test/demoSlackClient.test.ts`:
```ts
import { header, SlackApiError } from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { describe, expect, it } from "vitest";
import { DemoSlackClient, readDemoEvents } from "../src/demo/slackClient";

describe("DemoSlackClient", () => {
  it("records views, responses and statuses in order, per session", async () => {
    const db = createTestDb();
    let t = 1_000;
    const slack = new DemoSlackClient(db, "S1", () => t++);
    const other = new DemoSlackClient(db, "S2", () => 5);
    await slack.openView({
      botToken: "b",
      triggerId: "trig",
      view: { type: "modal", callback_id: "cb", title: { type: "plain_text", text: "t" }, blocks: [header("h")] },
    });
    await slack.setUserStatus({ userToken: "xoxp-demo-U_DANA", text: "Out", emoji: ":palm_tree:", expiration: 99 });
    await slack.respond({ responseUrl: "https://hooks.slack.com/demo/S1", text: "receipt", blocks: [header("r")] });
    await slack.clearUserStatus({ userToken: "xoxp-demo-U_DANA" });
    await other.setUserStatus({ userToken: "xoxp-demo-U_OMER", text: "x", emoji: ":x:", expiration: 0 });

    const events = await readDemoEvents(db, "S1");
    expect(events.map((e) => [e.seq, e.kind, e.at])).toEqual([
      [1, "view", 1000],
      [2, "status", 1001],
      [3, "response", 1002],
      [4, "status", 1003],
    ]);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({ triggerId: "trig", view: { callback_id: "cb" } });
    expect(JSON.parse(events[1]?.payload ?? "{}")).toEqual({
      userToken: "xoxp-demo-U_DANA",
      status: { text: "Out", emoji: ":palm_tree:", expiration: 99 },
    });
    expect(JSON.parse(events[2]?.payload ?? "{}")).toMatchObject({ text: "receipt", replaceOriginal: false });
    expect(JSON.parse(events[3]?.payload ?? "{}")).toEqual({ userToken: "xoxp-demo-U_DANA", status: null });
    expect(await readDemoEvents(db, "S2")).toHaveLength(1);
  });

  it("refuses untrusted response URLs like the real client and answers users.info with null", async () => {
    const db = createTestDb();
    const slack = new DemoSlackClient(db, "S1", () => 1);
    await expect(slack.respond({ responseUrl: "https://evil.example/x", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    expect(await readDemoEvents(db, "S1")).toHaveLength(0);
    expect(await slack.getUserInfo({ botToken: "b", userId: "U" })).toBeNull();
  });
});
```

Run: `pnpm exec vitest run apps/worker/test/demoSlackClient.test.ts`
Expected: FAIL — module `../src/demo/slackClient` not found.

- [ ] **Step 3: Implement the client**

Create `apps/worker/src/demo/slackClient.ts`:
```ts
import {
  assertTrustedResponseUrl,
  type Db,
  type DemoEventRow,
  type ModalView,
  newId,
  type RespondArgs,
  schema,
  type SetStatusArgs,
  type SlackClient,
  type UserProfile,
} from "@steward/core";
import { eq, max } from "drizzle-orm";

export type DemoEventKind = "view" | "response" | "status";

/**
 * The demo's Slack: every call becomes a `demo_events` row the emulator reads back.
 * Same interface and the same checks as the real client; nothing leaves the database.
 */
export class DemoSlackClient implements SlackClient {
  constructor(
    private readonly db: Db,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  private async record(kind: DemoEventKind, payload: unknown): Promise<void> {
    const [row] = await this.db
      .select({ seq: max(schema.demoEvents.seq) })
      .from(schema.demoEvents)
      .where(eq(schema.demoEvents.sessionId, this.sessionId));
    const seq = (row?.seq ?? 0) + 1;
    await this.db.insert(schema.demoEvents).values({
      id: newId(),
      sessionId: this.sessionId,
      seq,
      kind,
      payload: JSON.stringify(payload),
      at: this.now(),
    });
  }

  async openView(args: { botToken: string; triggerId: string; view: ModalView }): Promise<{ viewId: string }> {
    await this.record("view", { triggerId: args.triggerId, view: args.view });
    return { viewId: `V-demo-${args.triggerId}` };
  }

  async respond(args: RespondArgs): Promise<void> {
    assertTrustedResponseUrl(args.responseUrl);
    await this.record("response", {
      responseUrl: args.responseUrl,
      text: args.text,
      blocks: args.blocks ?? [],
      replaceOriginal: args.replaceOriginal ?? false,
    });
  }

  async setUserStatus(args: SetStatusArgs): Promise<void> {
    await this.record("status", {
      userToken: args.userToken,
      status: { text: args.text, emoji: args.emoji, expiration: args.expiration },
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    await this.record("status", { userToken: args.userToken, status: null });
  }

  /** Demo people are seeded with their profile already synced, so this is not reached in practice. */
  async getUserInfo(_args: { botToken: string; userId: string }): Promise<UserProfile | null> {
    return null;
  }
}

export async function readDemoEvents(db: Db, sessionId: string): Promise<DemoEventRow[]> {
  return db
    .select()
    .from(schema.demoEvents)
    .where(eq(schema.demoEvents.sessionId, sessionId))
    .orderBy(schema.demoEvents.seq);
}
```

Run: `pnpm exec vitest run apps/worker/test/demoSlackClient.test.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (97 tests).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(demo): session and event tables; a Slack client that records every call for the emulator

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 3: Demo sessions — create, seed, per-session deps, cleanup

**Files:**
- Create: `apps/worker/src/demo/session.ts`
- Modify: `apps/worker/src/tick.ts`
- Test: `apps/worker/test/demoSession.test.ts`, `apps/worker/test/tick.test.ts`

**Interfaces:**
- Produces (all from `apps/worker/src/demo/session.ts`):
  ```ts
  export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;
  export const DEMO_MAX_LIVE_SESSIONS = 200;
  export const DEMO_MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;
  export const DEMO_PEOPLE: readonly { slackUserId: string; displayName: string; tz: string }[];  // Dana (you), Omer, Noa
  export type DemoSession = DemoSessionRow & { workspaceId: string };
  export const demoWorkspaceId: (sessionId: string) => string;                                   // `demo:<id>`
  export async function createDemoSession(deps: Deps, opts: { visitorTz?: string }): Promise<DemoSession | { error: "busy" }>;
  export async function getDemoSession(deps: Pick<Deps, "db" | "now">, id: string): Promise<DemoSession | null>;  // null when missing or expired
  export async function advanceDemoClock(deps: Deps, session: DemoSession, byMs: number): Promise<DemoSession>;
  export function demoDeps(deps: Deps, session: DemoSession): Deps & { settle: () => Promise<void> };
  export async function cleanupDemoSessions(deps: Pick<Deps, "db" | "now">): Promise<number>;    // sessions removed
  ```
  `runTick` returns `{ undoWindowsExpired: number; demoSessionsRemoved: number }`.

- [ ] **Step 1: Failing tests**

Create `apps/worker/test/demoSession.test.ts`:
```ts
import { getPerson, getWorkspace, open, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  advanceDemoClock,
  cleanupDemoSessions,
  createDemoSession,
  DEMO_MAX_ADVANCE_MS,
  DEMO_MAX_LIVE_SESSIONS,
  DEMO_SESSION_TTL_MS,
  demoDeps,
  demoWorkspaceId,
  getDemoSession,
} from "../src/demo/session";
import { NOW, testDeps } from "./helpers";

describe("demo sessions", () => {
  it("creates a session with a workspace and three synced people; 'you' gets the visitor's zone", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, { visitorTz: "Europe/Warsaw" });
    if ("error" in s) throw new Error("unexpected busy");
    expect(s.workspaceId).toBe(demoWorkspaceId(s.id));
    expect(s.expiresAt).toBe(NOW + DEMO_SESSION_TTL_MS);
    const ws = await getWorkspace(deps.db, s.workspaceId);
    expect(ws?.name).toBe("Acme (demo)");
    expect(ws && (await open(deps.tokenKey, ws.botTokenSealed))).toBe("xoxb-demo");
    const you = await getPerson(deps.db, s.youPersonId);
    expect(you).toMatchObject({ slackUserId: "U_DANA", displayName: "Dana", tz: "Europe/Warsaw", profileSyncedAt: NOW });
    expect(you?.userTokenSealed && (await open(deps.tokenKey, you.userTokenSealed))).toBe("xoxp-demo-U_DANA");
    const people = await deps.db.select().from(schema.people).where(eq(schema.people.workspaceId, s.workspaceId));
    expect(people.map((p) => p.displayName).sort()).toEqual(["Dana", "Noa", "Omer"]);
  });

  it("falls back to UTC for an unknown visitor zone, and is not found once expired", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, { visitorTz: "Not/AZone" });
    if ("error" in s) throw new Error("unexpected busy");
    expect((await getPerson(deps.db, s.youPersonId))?.tz).toBe("UTC");
    expect(await getDemoSession(deps, s.id)).not.toBeNull();
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS;
    expect(await getDemoSession(deps, s.id)).toBeNull();
    expect(await getDemoSession(deps, "nope")).toBeNull();
  });

  it("demo deps shift the clock, run deferred work on settle, and cap the advance", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const shifted = await advanceDemoClock(deps, s, 5 * 60 * 1000);
    expect(shifted.clockOffsetMs).toBe(5 * 60 * 1000);
    const d = demoDeps(deps, shifted);
    expect(d.now()).toBe(NOW + 5 * 60 * 1000);
    let ran = false;
    d.defer(
      (async () => {
        ran = true;
      })(),
    );
    await d.settle();
    expect(ran).toBe(true);
    const capped = await advanceDemoClock(deps, shifted, DEMO_MAX_ADVANCE_MS);
    expect(capped.clockOffsetMs).toBe(DEMO_MAX_ADVANCE_MS);
  });

  it("refuses new sessions when too many are live", async () => {
    const deps = testDeps();
    for (let i = 0; i < DEMO_MAX_LIVE_SESSIONS; i++) {
      const s = await createDemoSession(deps, {});
      if ("error" in s) throw new Error(`busy too early at ${i}`);
    }
    expect(await createDemoSession(deps, {})).toEqual({ error: "busy" });
  });

  it("cleanup removes expired sessions and everything they own, and nothing else", async () => {
    const deps = testDeps();
    const old = await createDemoSession(deps, {});
    deps.clock.now = NOW + 30 * 60 * 1000;
    const fresh = await createDemoSession(deps, {});
    if ("error" in old || "error" in fresh) throw new Error("unexpected busy");
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect(await cleanupDemoSessions(deps)).toBe(1);
    expect(await getWorkspace(deps.db, old.workspaceId)).toBeNull();
    expect(await deps.db.select().from(schema.people).where(eq(schema.people.workspaceId, old.workspaceId))).toHaveLength(0);
    expect(await deps.db.select().from(schema.demoSessions).where(eq(schema.demoSessions.id, old.id))).toHaveLength(0);
    expect(await getWorkspace(deps.db, fresh.workspaceId)).not.toBeNull();
    expect(await cleanupDemoSessions(deps)).toBe(0);
  });
});
```

In `apps/worker/test/tick.test.ts`: the existing expectation `{ undoWindowsExpired: 1 }` becomes `{ undoWindowsExpired: 1, demoSessionsRemoved: 0 }` (and `{ undoWindowsExpired: 0, demoSessionsRemoved: 0 }` for the second run); add:
```ts
  it("the tick also cleans expired demo sessions", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect(await runTick(deps)).toEqual({ undoWindowsExpired: 0, demoSessionsRemoved: 1 });
  });
```
(import `createDemoSession`, `DEMO_SESSION_TTL_MS` from `../src/demo/session`).

Run: `pnpm exec vitest run apps/worker/test/demoSession.test.ts apps/worker/test/tick.test.ts`
Expected: FAIL — module `../src/demo/session` not found.

- [ ] **Step 2: Implement sessions**

Create `apps/worker/src/demo/session.ts`:
```ts
import {
  type Db,
  type DemoSessionRow,
  ensurePerson,
  newId,
  schema,
  seal,
  setPersonUserToken,
  updatePersonProfile,
  upsertWorkspace,
} from "@steward/core";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { Deps } from "../deps";
import { isKnownTimeZone } from "../people";
import { DemoSlackClient } from "./slackClient";

export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEMO_MAX_LIVE_SESSIONS = 200;
export const DEMO_MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;

/** The sample team. The first one is "you"; their zone follows the visitor's browser. */
export const DEMO_PEOPLE = [
  { slackUserId: "U_DANA", displayName: "Dana", tz: "Europe/London" },
  { slackUserId: "U_OMER", displayName: "Omer", tz: "America/New_York" },
  { slackUserId: "U_NOA", displayName: "Noa", tz: "Asia/Jerusalem" },
] as const;

export type DemoSession = DemoSessionRow & { workspaceId: string };

export const demoWorkspaceId = (sessionId: string): string => `demo:${sessionId}`;

const withWorkspace = (row: DemoSessionRow): DemoSession => ({ ...row, workspaceId: demoWorkspaceId(row.id) });

async function liveSessionCount(db: Db, now: number): Promise<number> {
  const rows = await db
    .select({ id: schema.demoSessions.id })
    .from(schema.demoSessions)
    .where(gt(schema.demoSessions.expiresAt, now));
  return rows.length;
}

/** A fresh demo tenant: workspace `demo:<id>`, three people already "connected", an hour to live. */
export async function createDemoSession(
  deps: Deps,
  opts: { visitorTz?: string },
): Promise<DemoSession | { error: "busy" }> {
  const now = deps.now();
  if ((await liveSessionCount(deps.db, now)) >= DEMO_MAX_LIVE_SESSIONS) return { error: "busy" };
  const id = newId();
  const workspaceId = demoWorkspaceId(id);
  await upsertWorkspace(deps.db, {
    id: workspaceId,
    name: "Acme (demo)",
    botTokenSealed: await seal(deps.tokenKey, "xoxb-demo"),
    botUserId: "U_STEWARD",
    installedAt: now,
  });
  let youPersonId = "";
  for (const [i, p] of DEMO_PEOPLE.entries()) {
    const person = await ensurePerson(deps.db, workspaceId, p.slackUserId, p.displayName);
    const visitorTz = opts.visitorTz && isKnownTimeZone(opts.visitorTz) ? opts.visitorTz : "UTC";
    const tz = i === 0 ? visitorTz : p.tz;
    await updatePersonProfile(deps.db, person.id, { displayName: p.displayName, tz, profileSyncedAt: now });
    await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, `xoxp-demo-${p.slackUserId}`));
    if (i === 0) youPersonId = person.id;
  }
  const row: DemoSessionRow = {
    id,
    createdAt: now,
    expiresAt: now + DEMO_SESSION_TTL_MS,
    clockOffsetMs: 0,
    youPersonId,
  };
  await deps.db.insert(schema.demoSessions).values(row);
  return withWorkspace(row);
}

export async function getDemoSession(deps: Pick<Deps, "db" | "now">, id: string): Promise<DemoSession | null> {
  const rows = await deps.db
    .select()
    .from(schema.demoSessions)
    .where(and(eq(schema.demoSessions.id, id), gt(schema.demoSessions.expiresAt, deps.now())));
  const row = rows[0];
  return row ? withWorkspace(row) : null;
}

export async function advanceDemoClock(deps: Deps, session: DemoSession, byMs: number): Promise<DemoSession> {
  const clockOffsetMs = Math.min(DEMO_MAX_ADVANCE_MS, Math.max(0, session.clockOffsetMs + byMs));
  await deps.db.update(schema.demoSessions).set({ clockOffsetMs }).where(eq(schema.demoSessions.id, session.id));
  return { ...session, clockOffsetMs };
}

/**
 * The deps a demo request runs with: the recording Slack client, the session's shifted clock, and a
 * `defer` that collects work so the route can `settle()` it before answering — the emulator must see
 * the receipt in the same round trip.
 */
export function demoDeps(deps: Deps, session: DemoSession): Deps & { settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const now = () => deps.now() + session.clockOffsetMs;
  return {
    ...deps,
    now,
    slack: new DemoSlackClient(deps.db, session.id, now),
    defer: (work) => {
      pending.push(work);
    },
    settle: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

/** Deletes every expired session and all rows its workspace owns. Returns how many sessions went. */
export async function cleanupDemoSessions(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const expired = await deps.db
    .select()
    .from(schema.demoSessions)
    .where(lte(schema.demoSessions.expiresAt, deps.now()));
  for (const s of expired) {
    const workspaceId = demoWorkspaceId(s.id);
    const statusIds = (
      await deps.db
        .select({ id: schema.statuses.id })
        .from(schema.statuses)
        .where(eq(schema.statuses.workspaceId, workspaceId))
    ).map((r) => r.id);
    if (statusIds.length > 0) {
      await deps.db.delete(schema.statusTargets).where(inArray(schema.statusTargets.statusId, statusIds));
    }
    await deps.db.delete(schema.statuses).where(eq(schema.statuses.workspaceId, workspaceId));
    await deps.db.delete(schema.audit).where(eq(schema.audit.workspaceId, workspaceId));
    await deps.db.delete(schema.people).where(eq(schema.people.workspaceId, workspaceId));
    await deps.db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await deps.db.delete(schema.demoEvents).where(eq(schema.demoEvents.sessionId, s.id));
    await deps.db.delete(schema.demoSessions).where(eq(schema.demoSessions.id, s.id));
  }
  return expired.length;
}
```
(`isKnownTimeZone` is exported from `apps/worker/src/people.ts` since Plan 2a's fix wave.)

In `apps/worker/src/tick.ts`, add `import { cleanupDemoSessions } from "./demo/session";` and make `runTick`:
```ts
/** Runs once a minute from the cron trigger. Plan 3 adds scheduled fires, asks and retries here. */
export async function runTick(
  deps: Pick<Deps, "db" | "now">,
): Promise<{ undoWindowsExpired: number; demoSessionsRemoved: number }> {
  return {
    undoWindowsExpired: await expireUndoWindows(deps),
    demoSessionsRemoved: await cleanupDemoSessions(deps),
  };
}
```

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (103 tests: 97 + 5 session + 1 tick).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(demo): sessions with a seeded sample team, shifted clock, inline defer, and hourly cleanup

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

### Task 4: The demo routes

**Files:**
- Create: `apps/worker/src/routes/demo.ts`
- Modify: `apps/worker/src/app.ts`
- Test: `apps/worker/test/demo.test.ts`

**Interfaces:**
- Produces, under `/demo`:
  - `POST /demo/sessions` body `{ tz?: string }` → 201 `{ id, expiresAt, clockOffsetMs, you: { slackUserId, displayName, tz }, people: [...] }`; 429 `{ error: "busy" }`.
  - `GET /demo/:id/state` → `{ now, expiresAt, clockOffsetMs, events: [{ seq, kind, at, payload }] }` (payload parsed); 404 `{ error: "gone" }` when missing or expired.
  - `POST /demo/:id/command` body `{ text: string }` (must start with `/ooo`) → `{ text }` — what Slack would show at once; the opened form arrives as a `view` event. 400 for any other command.
  - `POST /demo/:id/interact` body: a Slack-shaped interaction payload; the server sets `team.id`, `user`, `response_url` and (for `view_submission`) the view's `private_metadata` to the session's own values → the handler's answer (`{ response_action: … }` or `""`). 400 when the body is not an object with a `type`.
  - `POST /demo/:id/advance` body `{ minutes: number }` → the new state (as `GET /state`); 400 otherwise.

- [ ] **Step 1: Failing flow test**

Create `apps/worker/test/demo.test.ts`:
```ts
import { STATUS_MODAL_CALLBACK, todayIn, UNDO_ACTION } from "@steward/availability";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { NOW, testDeps } from "./helpers";

type Created = { id: string; you: { slackUserId: string; tz: string }; expiresAt: number };
type Ev = { seq: number; kind: string; payload: Record<string, unknown> };
type State = { now: number; events: Ev[] };
type Blocks = { type: string; elements?: { action_id?: string; value?: string }[]; element?: { initial_date?: string } }[];

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getState = async (app: ReturnType<typeof createApp>, id: string) =>
  (await (await app.request(`/demo/${id}/state`)).json()) as State;

function submission(from: string, to: string) {
  return {
    type: "view_submission",
    team: { id: "T_SOMEONE_ELSE" },
    user: { id: "U_SOMEONE_ELSE" },
    view: {
      callback_id: STATUS_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ responseUrl: "https://evil.example/x" }),
      state: {
        values: {
          type: { type: { type: "static_select", selected_option: { value: "out" } } },
          from: { from: { type: "datepicker", selected_date: from } },
          to: { to: { type: "datepicker", selected_date: to } },
          text: { text: { type: "plain_text_input", value: null } },
          emoji: { emoji: { type: "plain_text_input", value: null } },
        },
      },
    },
  };
}
const undoValue = (blocks: Blocks) => blocks.find((b) => b.type === "actions")?.elements?.[0]?.value ?? "";

describe("/demo", () => {
  it("runs the whole /ooo flow for a visitor, against the recording Slack, in their own zone", async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const created = await post(app, "/demo/sessions", { tz: "Asia/Tokyo" });
    expect(created.status).toBe(201);
    const s = (await created.json()) as Created;
    expect(s.you).toMatchObject({ slackUserId: "U_DANA", tz: "Asia/Tokyo" });

    const cmd = await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    expect(await cmd.json()).toEqual({ text: "" });
    let state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view"]);
    const view = state.events[0]?.payload.view as { callback_id: string; blocks: Blocks };
    expect(view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    const today = todayIn("Asia/Tokyo", NOW);
    expect(view.blocks[1]?.element?.initial_date).toBe(today);

    const saved = await post(app, `/demo/${s.id}/interact`, submission(today, today));
    expect(await saved.json()).toEqual({ response_action: "clear" });
    state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view", "status", "response"]);
    expect(state.events[1]?.payload).toMatchObject({ userToken: "xoxp-demo-U_DANA", status: { text: "Out of office" } });
    const receipt = state.events[2]?.payload as { responseUrl: string; text: string; blocks: Blocks };
    expect(receipt.responseUrl).toBe(`https://hooks.slack.com/demo/${s.id}`);
    expect(receipt.text).toMatch(/^Out of office · /);
    expect(JSON.stringify(receipt.blocks)).toContain("✅ Slack status set");

    const undo = await post(app, `/demo/${s.id}/interact`, {
      type: "block_actions",
      team: { id: "T_X" },
      user: { id: "U_X" },
      response_url: "https://evil.example/x",
      actions: [{ action_id: UNDO_ACTION, value: undoValue(receipt.blocks) }],
    });
    expect(undo.status).toBe(200);
    state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view", "status", "response", "status", "response"]);
    expect((state.events[3]?.payload as { status: unknown }).status).toBeNull();
    expect((state.events[4]?.payload as { text: string }).text).toMatch(/^Undone · /);
  });

  it("advances time so the undo window closes, and a gone session is a 404", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const today = todayIn("UTC", NOW);
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${s.id}/interact`, submission(today, today));
    const advanced = await post(app, `/demo/${s.id}/advance`, { minutes: 6 });
    expect(((await advanced.json()) as State).now).toBe(NOW + 6 * 60 * 1000);
    let state = await getState(app, s.id);
    const receipt = state.events[2]?.payload as { blocks: Blocks };
    await post(app, `/demo/${s.id}/interact`, {
      type: "block_actions",
      team: { id: "x" },
      user: { id: "x" },
      response_url: "x",
      actions: [{ action_id: UNDO_ACTION, value: undoValue(receipt.blocks) }],
    });
    state = await getState(app, s.id);
    expect((state.events.at(-1)?.payload as { text: string }).text).toBe("The five-minute undo window has passed.");

    deps.clock.now = NOW + 61 * 60 * 1000;
    expect((await app.request(`/demo/${s.id}/state`)).status).toBe(404);
    expect((await post(app, `/demo/${s.id}/command`, { text: "/ooo" })).status).toBe(404);
  });

  it("rejects bad input plainly", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    expect((await post(app, `/demo/${s.id}/command`, { text: "/other" })).status).toBe(400);
    expect((await post(app, `/demo/${s.id}/interact`, "not an object")).status).toBe(400);
    expect((await post(app, `/demo/${s.id}/advance`, { minutes: "soon" })).status).toBe(400);
  });
});
```

Run: `pnpm exec vitest run apps/worker/test/demo.test.ts`
Expected: FAIL — 404 on `/demo/sessions` (no route yet).

- [ ] **Step 2: Implement the routes**

Create `apps/worker/src/routes/demo.ts`:
```ts
import { getPerson, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  advanceDemoClock,
  createDemoSession,
  type DemoSession,
  demoDeps,
  getDemoSession,
} from "../demo/session";
import { readDemoEvents } from "../demo/slackClient";
import type { Deps } from "../deps";
import { handleInteraction, handleSlashCommand } from "../slack/handlers";

type Vars = { Variables: { session: DemoSession } };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const responseUrlFor = (session: DemoSession) => `https://hooks.slack.com/demo/${session.id}`;

async function stateOf(deps: Deps, session: DemoSession) {
  const events = await readDemoEvents(deps.db, session.id);
  return {
    now: deps.now() + session.clockOffsetMs,
    expiresAt: session.expiresAt,
    clockOffsetMs: session.clockOffsetMs,
    events: events.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, payload: JSON.parse(e.payload) as unknown })),
  };
}

export function demoRoutes(deps: Deps) {
  const r = new Hono<Vars>();

  r.post("/sessions", async (c) => {
    const body = await readJson(c);
    const visitorTz = isObject(body) && typeof body.tz === "string" ? body.tz : undefined;
    const session = await createDemoSession(deps, { visitorTz });
    if ("error" in session) return c.json({ error: "busy" }, 429);
    const people = await deps.db
      .select()
      .from(schema.people)
      .where(eq(schema.people.workspaceId, session.workspaceId));
    const brief = (p: { slackUserId: string; displayName: string; tz: string }) => ({
      slackUserId: p.slackUserId,
      displayName: p.displayName,
      tz: p.tz,
    });
    const you = people.find((p) => p.id === session.youPersonId);
    return c.json(
      {
        id: session.id,
        expiresAt: session.expiresAt,
        clockOffsetMs: session.clockOffsetMs,
        you: you ? brief(you) : null,
        people: people.map(brief),
      },
      201,
    );
  });

  // Every route below needs a live session.
  r.use("/:id/*", async (c, next) => {
    const session = await getDemoSession(deps, c.req.param("id") ?? "");
    if (!session) return c.json({ error: "gone" }, 404);
    c.set("session", session);
    await next();
  });

  r.get("/:id/state", async (c) => c.json(await stateOf(deps, c.get("session"))));

  r.post("/:id/command", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    const text = isObject(body) && typeof body.text === "string" ? body.text.trim() : "";
    if (!text.startsWith("/ooo")) return c.json({ error: "Only /ooo is available in the demo." }, 400);
    const you = await getPerson(deps.db, session.youPersonId);
    const d = demoDeps(deps, session);
    const form = new URLSearchParams({
      command: "/ooo",
      text: text.slice("/ooo".length).trim(),
      team_id: session.workspaceId,
      user_id: you?.slackUserId ?? "U_DANA",
      user_name: you?.displayName ?? "you",
      trigger_id: `demo-${d.now()}`,
      response_url: responseUrlFor(session),
    });
    const answer = await handleSlashCommand(d, form);
    await d.settle();
    return c.json({ text: answer });
  });

  r.post("/:id/interact", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    if (!isObject(body) || typeof body.type !== "string") {
      return c.json({ error: "Send a Slack-shaped interaction payload." }, 400);
    }
    const you = await getPerson(deps.db, session.youPersonId);
    // The visitor never chooses the workspace, the user, or where receipts go.
    const payload: Record<string, unknown> = {
      ...body,
      team: { id: session.workspaceId },
      user: { id: you?.slackUserId ?? "U_DANA", username: you?.displayName ?? "you" },
      response_url: responseUrlFor(session),
    };
    if (payload.type === "view_submission" && isObject(payload.view)) {
      payload.view = {
        ...payload.view,
        private_metadata: JSON.stringify({ responseUrl: responseUrlFor(session) }),
      };
    }
    const d = demoDeps(deps, session);
    const answer = await handleInteraction(d, payload);
    await d.settle();
    return answer.kind === "json" ? c.json(answer.body) : c.text(answer.body);
  });

  r.post("/:id/advance", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    const minutes =
      isObject(body) && typeof body.minutes === "number" && Number.isFinite(body.minutes) ? body.minutes : null;
    if (minutes === null) return c.json({ error: "Send { minutes: number }." }, 400);
    const advanced = await advanceDemoClock(deps, session, minutes * 60 * 1000);
    return c.json(await stateOf(deps, advanced));
  });

  return r;
}
```

In `apps/worker/src/app.ts` add `import { demoRoutes } from "./routes/demo";` and `app.route("/demo", demoRoutes(deps));`.

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (106 tests).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(demo): HTTP routes that drive the real /ooo flow for a visitor's session and expose the fake Slack's state

Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Self-review

**Coverage:** spec §5.6 "demo session" — a tenant per visitor with a seeded team (Task 3), a fake Slack with readable state (Task 2), the real code path driven over HTTP (Tasks 1, 4), time control (Tasks 3, 4), hourly expiry via the tick (Task 3). The browser emulator, the product page and serving static assets from the Worker are Plan 2b-ii. The spec's "fake connectors with visible state" for Calendar and Gmail arrive with those connectors in Plan 3 — the event log is already where they will write.

**Security:** the visitor never chooses the workspace, the user, the response URL or the view metadata — all are overwritten per session (Task 4); `DemoSlackClient.respond` still runs `assertTrustedResponseUrl`; demo tokens are sealed like real ones; sessions are capped and expire; cleanup deletes every row the workspace owns, targets included; demo and real workspaces never share an id (`demo:` prefix vs Slack team ids).

**Placeholder scan:** none; every code step shows the code.

**Type consistency:** `handleSlashCommand(deps, form): Promise<string>` and `handleInteraction(deps, rawPayload): Promise<InteractionAnswer>` are called that way by both route files; `demoDeps` returns `Deps & { settle }` and the routes call `settle()` before answering; `getDemoSession` returns null for expired sessions and the `/:id/*` middleware turns that into 404; `runTick` returns both counters and the tick tests expect both; `DEMO_PEOPLE[0]` is "you" and `createDemoSession` stores `youPersonId` from it; the demo test's `submission(from, to)` keys match the form's `FIELD` ids.

---

## Deviations recorded during execution (2026-11-09)

What was built differs from the tasks above in these ways. Each came from a review finding.

- **Seeding rolls back.** `createDemoSession` wraps seeding in try/catch. `deleteDemoWorkspace(db, sessionId)` was extracted from cleanup and removes a half-built workspace before the error is rethrown.
- **Orphan sweep with a grace.** `cleanupDemoSessions` also deletes `demo:%` workspaces that have no session row and are older than `DEMO_ORPHAN_GRACE_MS` (five minutes), found in one query. A failing sweep is logged and does not fail the tick. The returned number counts expired sessions that were removed, not orphans.
- **Deferred work.** `demoDeps().defer` attaches the error log at once, and `settle()` loops until nothing is pending, so work deferred by deferred work is finished before the response.
- **The visitor chooses even less.** `demoInteractionPayload(body, session, you)` is exported and overrides `view.private_metadata` for every interaction type, not only `view_submission`.
- **Routes.** `trigger_id` is `demo-<uuid>`. `/advance` refuses minutes outside 0 to 1440 with a 400. Request bodies over 32 KB get a 413. A `view_submission` or `block_actions` payload that lacks the parts the handler reads gets a 400. `handleInteraction` itself returns an empty answer for such payloads, so the signed Slack route cannot throw on them either.
- **Event numbers.** `DemoSlackClient.record` computes `seq` inside the INSERT, and the `(session_id, seq)` index is unique. Migration `0003_workable_mephistopheles.sql` makes that change and adds indexes on `statuses.workspace_id` and `audit.workspace_id`, which cleanup deletes by. Verified on a local D1 (Miniflare): six concurrent commands recorded distinct numbers.
- **Form input is bounded.** The emoji field is limited to 100 characters, and `readStatusSubmission` treats any value that is not a string as empty.
- **Off by default.** `/demo/*` answers 503 unless `DEMO_ENABLED` is `1` (`Deps.demoEnabled`). It stays off until Plan 2b-ii has shipped the demo's guard rails: a daily write budget, a per-session event cap, a rate limit, and a tick that fits D1's per-invocation query limit.
- **Counts.** 126 tests at the end of this plan (95 at its start); eight commits after the plan commit.

Carried forward, not built here: a single-statement clock advance with a refusal at the 24-hour cap, an atomic session budget, set-based cleanup and undo expiry, and status events that name the person instead of carrying the fake token (all Plan 2b-ii); the demo's place in the tick once the tick fires statuses, and Workers Logs (Plan 3). The spec's `demo_session_id` column (section 7) is replaced by the `demo:<session>` workspace id, which already scopes every row.
