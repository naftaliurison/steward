# Steward · Plan 2b-ii: The Browser Demo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public web front served by the same Worker: a product page at `/` and, at `/try`, a Slack-inspired emulator in which a visitor types `/ooo`, fills the real form, gets the real receipt, undoes it, and watches the fake Slack's state and the clock in a side panel.

**Architecture:** `apps/web` is a React app built by Vite to static files that the Worker serves through Wrangler's assets; API paths (`/slack/*`, `/oauth/*`, `/demo/*`, `/health`) always reach the Worker first, every other path falls back to `index.html`. The emulator holds no product logic: it creates a demo session, renders the Block Kit the backend recorded, and sends back Slack-shaped payloads built by pure functions. Those pure functions are proven against the real backend in-process by a contract test in the Worker's test suite.

**Before the demo can be switched on:** the first three tasks give the demo backend its guard rails: a write budget, limits on what it accepts, and a tick that fits the database's per-invocation query limit. The web tasks follow. The public demo stays off in production (`DEMO_ENABLED` unset) until this whole plan has merged and deployed.

**Tech Stack:** as Plans 1–2b-i, plus React 19, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), `@testing-library/react` 16 with jsdom 31 under the existing Vitest 3.

## Global Constraints

- The app is live: `main` deploys to the owner's Cloudflare account and serves a real Slack workspace. Every task must leave the signed Slack routes behaving exactly as they do now. Do not run `wrangler deploy`, `wrangler d1 migrations apply --remote` or any other command against the remote account; the controller does that after the plan merges.
- The platform's `fetch` is only ever called through the `platformFetch` wrapper in `apps/worker/src/deps.ts` (Workers rejects `fetch` called as a method of another object). In `apps/web`, call `fetch` plainly inside an arrow function, as the plan's code does.
- TypeScript end to end; ESM. `apps/web` may import from the rest of the monorepo **only** `@steward/core/blocks` (the Block Kit types and builders, a file with no imports). Nothing else from `@steward/core`, `@steward/availability` or `apps/worker` may be imported by anything under `apps/web/src`.
- `apps/web/src/demo/api.ts`, `model.ts` and `payloads.ts` are pure TypeScript: no React, no `window`, no `document`, no `sessionStorage`. The Worker's test suite imports them.
- The emulator shows only what the backend recorded. It never invents a receipt, a status or an error sentence of the product's; its own words are limited to chrome (labels, the side panel, session notices).
- Styling is Slack-inspired; no Slack marks, logos or brand names in the UI other than the plain word "Slack" in sentences. The emulator carries the note: "Slack-inspired styling. Steward is not affiliated with Slack."
- The Block Kit renderer covers the blocks the product emits today: `header`, `section` (text, fields, button accessory), `context`, `divider`, `actions` (buttons), and in modals `input` with `static_select`, `datepicker`, `plain_text_input`. Anything else renders as a visible "unsupported block" or "unsupported element" box. Never hide an unknown block.
- No `dangerouslySetInnerHTML`. No external fonts, scripts, analytics or network calls other than the same-origin API.
- Accessibility floor: every control is a real `button`, `a`, `input` or `select` with an accessible name; the modal is `role="dialog"` with `aria-modal`; errors are announced with `role="alert"`; the layout works at 375 px wide.
- Nothing from any employer in code, comments, fixtures or docs; fictional people Dana (you), Omer, Noa; fictional company Acme.
- Commits: conventional prefixes, one commit per task, trailer naming the Claude model that made the commit.
- Run from `C:\Users\nafta\steward`. `biome.json` is hook-protected; do not edit it. If a Biome rule must be silenced, use a `// biome-ignore <rule>: <reason>` comment on that line and name it in your report. Every task ends with `pnpm test`, `pnpm typecheck` and `pnpm lint` green; Tasks 4 and 8 also end with `pnpm build` green.
- Versions below are the latest at planning time. If `pnpm install` reports a peer-dependency conflict between Vite 8 and `@vitejs/plugin-react` or `@tailwindcss/vite`, use `vite@^7` with `@vitejs/plugin-react@^5` instead and say so in your report.

## Not in this plan

Playwright end-to-end tests, the "How it's built" page and the settings app arrive with the public link (spec section 12, week 4). The Home tab, the channel view and other people's actions arrive with the team view. Calendar and Gmail lines in the side panel arrive with the Google connectors.

---

## File structure

```
apps/web/
  package.json, tsconfig.json, vite.config.ts, index.html
  src/main.tsx                 picks the page from the path, mounts it
  src/index.css                Tailwind entry
  src/route.ts                 pageFor(pathname)
  src/pages/Product.tsx        the product page
  src/pages/Try.tsx            the /try page: mounts the emulator
  src/blockkit/emoji.ts        :shortcode: to Unicode for the handful the product uses
  src/blockkit/mrkdwn.tsx      Slack mrkdwn to React nodes (bold, italic, code, line breaks)
  src/blockkit/values.ts       a modal's field values and their starting state (pure)
  src/blockkit/Blocks.tsx      message blocks
  src/blockkit/Modal.tsx       a modal view with input blocks, values and errors
  src/demo/api.ts              typed client for /demo/* (pure)
  src/demo/model.ts            events to what the screen shows (pure)
  src/demo/payloads.ts         Slack-shaped payload builders (pure)
  src/demo/useDemoSession.ts   the hook that owns a session in the browser
  src/demo/Emulator.tsx        the workspace: sidebar, thread, composer, modal, side panel
apps/worker/
  wrangler.toml                [[ratelimits]], [observability], [assets]
  src/demo/session.ts          the day's session budget, the event cap, a one-statement clock, set-based cleanup
  src/demo/slackClient.ts      status events name the person, never the token
  src/routes/demo.ts           rate limit, JSON only, a spent session, a response URL per source message
  src/env.ts, src/deps.ts      the rate limiter binding
  src/tick.ts, src/index.ts    undo expiry in one statement; the tick logs what it did
  src/app.ts                   /health says whether Slack install is configured
  test/demo.d1.smoke.test.ts   the demo on the real D1 driver (Miniflare)
  test/webContract.test.ts     the web's pure modules against the real app
packages/core/
  src/db/schema.ts             demo_days
  drizzle/0004_*.sql           generated
  src/testing.ts               applyD1Migrations
  package.json                 exports "./blocks"
tsconfig.base.json, vitest.config.ts, package.json, .github/workflows/ci.yml, README.md
```


---

### Task 1: The demo's write budget

The demo is public and unauthenticated, and its rows share one database with real workspaces. D1's free tier allows 100,000 row writes a day. This task bounds what the demo can spend, exactly, before anything can switch it on.

**Files:**
- Modify: `packages/core/src/db/schema.ts`, `apps/worker/src/demo/session.ts`, `apps/worker/src/routes/demo.ts`
- Create: `packages/core/drizzle/0004_*.sql` and its `meta` files (generated)
- Test: `apps/worker/test/demoSession.test.ts`, `apps/worker/test/demo.test.ts`

**Interfaces:**
- Consumes: `createDemoSession`, `advanceDemoClock`, `DemoSession`, the `/demo` routes, and the test helpers already in those two test files (`post`, `getState`, `submission`, `Created`, `testDeps`, `NOW`).
- Produces:
  ```ts
  // packages/core/src/db/schema.ts
  export const demoDays; // table demo_days: day (text, primary key, "YYYY-MM-DD" in UTC), sessions (integer, not null)
  // apps/worker/src/demo/session.ts
  export const DEMO_MAX_LIVE_SESSIONS = 50;      // was 200
  export const DEMO_MAX_SESSIONS_PER_DAY = 150;
  export const DEMO_MAX_EVENTS = 40;
  /** Null when the clock is already a day ahead. Otherwise the session with the offset the database now holds. */
  export async function advanceDemoClock(deps: Pick<Deps, "db">, session: DemoSession, byMs: number): Promise<DemoSession | null>;
  ```
  Routes: `POST /demo/:id/command` and `/interact` answer 409 `{ error: "This demo session has done all it can. Start over to continue." }` once the session holds `DEMO_MAX_EVENTS` events. `POST /demo/:id/advance` answers 400 `{ error: "The demo clock is already a day ahead. Start over to rewind it." }` at the cap. `POST /demo/sessions` answers 429 `{ error: "busy" }` when the day's budget is spent, as it already does for the live cap.

- [ ] **Step 1: Write the failing tests**

Add to `describe("demo sessions", ...)` in `apps/worker/test/demoSession.test.ts` (import `DEMO_MAX_SESSIONS_PER_DAY` from `../src/demo/session`, and `eq` from `drizzle-orm` if the file does not already):

```ts
it("spends one of the day's session slots per create, and refuses when the day's budget is gone", async () => {
  const deps = testDeps();
  const day = new Date(NOW).toISOString().slice(0, 10);
  const today = () => deps.db.select().from(schema.demoDays).where(eq(schema.demoDays.day, day));
  await createDemoSession(deps, {});
  await createDemoSession(deps, {});
  expect((await today())[0]?.sessions).toBe(2);

  await deps.db
    .update(schema.demoDays)
    .set({ sessions: DEMO_MAX_SESSIONS_PER_DAY })
    .where(eq(schema.demoDays.day, day));
  expect(await createDemoSession(deps, {})).toEqual({ error: "busy" });
  expect((await today())[0]?.sessions).toBe(DEMO_MAX_SESSIONS_PER_DAY); // a refusal spends nothing

  deps.clock.now = NOW + 24 * 60 * 60 * 1000; // tomorrow has its own budget
  expect(await createDemoSession(deps, {})).not.toHaveProperty("error");
});

it("adds each clock advance to what the database holds, never goes back, and refuses at a day ahead", async () => {
  const deps = testDeps();
  const s = await createDemoSession(deps, {});
  if ("error" in s) throw new Error("unexpected busy");
  // Every call below passes the same stale session object, as requests racing each other would.
  await advanceDemoClock(deps, s, 10 * 60 * 1000);
  expect((await advanceDemoClock(deps, s, 10 * 60 * 1000))?.clockOffsetMs).toBe(20 * 60 * 1000);
  expect((await advanceDemoClock(deps, s, -5 * 60 * 1000))?.clockOffsetMs).toBe(20 * 60 * 1000);
  expect((await advanceDemoClock(deps, s, DEMO_MAX_ADVANCE_MS))?.clockOffsetMs).toBe(DEMO_MAX_ADVANCE_MS);
  expect(await advanceDemoClock(deps, s, 60 * 1000)).toBeNull();
});
```

In the existing test "demo deps shift the clock, run deferred work on settle, and cap the advance", the return type becomes nullable: after `const shifted = await advanceDemoClock(deps, s, 5 * 60 * 1000);` add `if (!shifted) throw new Error("the clock refused");`, and change `capped.clockOffsetMs` to `capped?.clockOffsetMs`.

Add to `describe("/demo", ...)` in `apps/worker/test/demo.test.ts` (import `DEMO_MAX_EVENTS` from `../src/demo/session`):

```ts
it("stops a session that has done all it can, with a sentence that says so", async () => {
  const app = createApp(testDeps());
  const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
  for (let i = 0; i < DEMO_MAX_EVENTS; i++) {
    expect((await post(app, `/demo/${id}/command`, { text: "/ooo" })).status).toBe(200);
  }
  const spent = { error: "This demo session has done all it can. Start over to continue." };
  const command = await post(app, `/demo/${id}/command`, { text: "/ooo" });
  expect(command.status).toBe(409);
  expect(await command.json()).toEqual(spent);
  const today = todayIn("UTC", NOW);
  const interact = await post(app, `/demo/${id}/interact`, submission(today, today));
  expect(interact.status).toBe(409);
  expect(await interact.json()).toEqual(spent);
  expect((await getState(app, id)).events).toHaveLength(DEMO_MAX_EVENTS);
});

it("says so when the clock cannot go further", async () => {
  const app = createApp(testDeps());
  const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
  expect((await post(app, `/demo/${id}/advance`, { minutes: 1440 })).status).toBe(200);
  const more = await post(app, `/demo/${id}/advance`, { minutes: 5 });
  expect(more.status).toBe(400);
  expect(await more.json()).toEqual({
    error: "The demo clock is already a day ahead. Start over to rewind it.",
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test`
Expected: the new tests fail (`schema.demoDays` and the two constants do not exist; the 41st command answers 200; the second advance answers 200); everything else passes.

- [ ] **Step 3: Add the table and generate its migration**

In `packages/core/src/db/schema.ts`, next to the other demo tables:

```ts
/** One row per UTC day: how many demo sessions were started that day. The demo's daily budget is claimed here. */
export const demoDays = sqliteTable("demo_days", {
  day: text("day").primaryKey(),
  sessions: integer("sessions").notNull(),
});
```

Run: `pnpm --filter @steward/core db:generate`
Expected: a new `packages/core/drizzle/0004_*.sql` containing only `CREATE TABLE \`demo_days\` ...`. Read it. Do not touch migrations 0000 to 0003.

- [ ] **Step 4: Bound the sessions and make the clock one statement**

In `apps/worker/src/demo/session.ts`, add `count` and `lt` to the `drizzle-orm` import, and replace the `DEMO_MAX_LIVE_SESSIONS` line with:

```ts
/**
 * The demo's write budget. D1's free tier allows 100,000 row writes a day, shared with real
 * workspaces. A save-and-undo cycle records 5 events and writes about 20 rows, so a session capped
 * at 40 events writes about 200 rows with its seed and cleanup, and 150 sessions a day keep the
 * demo near 30,000 writes: under a third of the allowance.
 */
export const DEMO_MAX_LIVE_SESSIONS = 50;
export const DEMO_MAX_SESSIONS_PER_DAY = 150;
export const DEMO_MAX_EVENTS = 40;
```

Replace `liveSessionCount` and add `claimDailySlot` under it:

```ts
async function liveSessionCount(db: Db, now: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.demoSessions)
    .where(gt(schema.demoSessions.expiresAt, now));
  return row?.n ?? 0;
}

/** Takes one of today's session slots. One statement, so creates racing each other cannot overshoot the day. */
async function claimDailySlot(db: Db, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = await db
    .insert(schema.demoDays)
    .values({ day, sessions: 1 })
    .onConflictDoUpdate({
      target: schema.demoDays.day,
      set: { sessions: sql`${schema.demoDays.sessions} + 1` },
      setWhere: lt(schema.demoDays.sessions, DEMO_MAX_SESSIONS_PER_DAY),
    })
    .returning({ sessions: schema.demoDays.sessions });
  return rows.length > 0;
}
```

In `createDemoSession`, after the existing live-count line, add:

```ts
  // The live cap above is a soft check: creates racing each other can overshoot it by a few.
  // The day's budget is exact.
  if (!(await claimDailySlot(deps.db, now))) return { error: "busy" };
```

Replace `advanceDemoClock` with:

```ts
/**
 * Moves the session's clock forward by `byMs`, never back. One statement that adds to what the
 * database holds, so two presses at once both count. Null when the clock is already a day ahead.
 */
export async function advanceDemoClock(
  deps: Pick<Deps, "db">,
  session: DemoSession,
  byMs: number,
): Promise<DemoSession | null> {
  const add = Number.isFinite(byMs) && byMs > 0 ? Math.floor(byMs) : 0;
  const rows = await deps.db
    .update(schema.demoSessions)
    .set({
      clockOffsetMs: sql`min(${schema.demoSessions.clockOffsetMs} + ${add}, ${DEMO_MAX_ADVANCE_MS})`,
    })
    .where(
      and(
        eq(schema.demoSessions.id, session.id),
        lt(schema.demoSessions.clockOffsetMs, DEMO_MAX_ADVANCE_MS),
      ),
    )
    .returning({ clockOffsetMs: schema.demoSessions.clockOffsetMs });
  const row = rows[0];
  return row ? { ...session, clockOffsetMs: row.clockOffsetMs } : null;
}
```

If the installed drizzle-orm rejects `setWhere` or `.returning()` on the shared `Db` type, keep the statement single and atomic by writing it with the `sql` template through `db.run`/`db.all` with bound parameters, and say so in your report. Do not split either statement in two.

- [ ] **Step 5: Refuse a spent session and a clock at its cap in the routes**

In `apps/worker/src/routes/demo.ts`, import `count` from `drizzle-orm` and `DEMO_MAX_EVENTS` from `../demo/session`, and add above `demoRoutes`:

```ts
const SPENT = "This demo session has done all it can. Start over to continue.";
const CLOCK_AT_CAP = "The demo clock is already a day ahead. Start over to rewind it.";

/** True once the session has recorded all the events it may. */
async function isSpent(deps: Deps, session: DemoSession): Promise<boolean> {
  const [row] = await deps.db
    .select({ n: count() })
    .from(schema.demoEvents)
    .where(eq(schema.demoEvents.sessionId, session.id));
  return (row?.n ?? 0) >= DEMO_MAX_EVENTS;
}
```

In the `/:id/command` handler, directly after the "Only /ooo" refusal, and in the `/:id/interact` handler, directly after the shape refusal, add:

```ts
    if (await isSpent(deps, session)) return c.json({ error: SPENT }, 409);
```

In the `/:id/advance` handler, replace the last two lines with:

```ts
    const advanced = await advanceDemoClock(deps, session, minutes * 60 * 1000);
    if (!advanced) return c.json({ error: CLOCK_AT_CAP }, 400);
    return c.json(await stateOf(deps, advanced));
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass. "refuses new sessions when too many are live" now creates 50 sessions, not 200.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0.

```bash
git add packages/core/src/db/schema.ts packages/core/drizzle apps/worker/src/demo/session.ts apps/worker/src/routes/demo.ts apps/worker/test/demoSession.test.ts apps/worker/test/demo.test.ts
git commit -m "feat(demo): a write budget: a day's sessions claimed in one statement, an event cap per session, a clock that adds up and says when it is at its cap"
```

---

### Task 2: What the demo accepts and what it reveals

**Files:**
- Modify: `apps/worker/src/demo/slackClient.ts`, `apps/worker/src/demo/session.ts`, `apps/worker/src/routes/demo.ts`, `apps/worker/src/env.ts`, `apps/worker/src/deps.ts`, `apps/worker/wrangler.toml`
- Test: `apps/worker/test/demoSlackClient.test.ts`, `apps/worker/test/demo.test.ts`

**Interfaces:**
- Consumes: `DemoSlackClient`, `readDemoEvents`, `demoRoutes`, `Deps`, `Env`, `testDeps` (its `overrides` argument accepts any `Deps` field except `slack`, `db`, `defer`).
- Produces:
  ```ts
  // apps/worker/src/demo/slackClient.ts
  export const DEMO_USER_TOKEN_PREFIX = "xoxp-demo-";
  // A recorded "status" event's payload is now
  //   { slackUserId: string; status: { text: string; emoji: string; expiration: number } | null }
  // It no longer carries `userToken`. Nothing readable through /demo/:id/state contains a token.
  // apps/worker/src/env.ts
  export type DemoLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
  // Env.DEMO_LIMITER?: DemoLimiter        (Cloudflare's rate limiting binding)
  // apps/worker/src/deps.ts: Deps.demoLimiter?: DemoLimiter
  ```
  Routes: every `POST` under `/demo` must have a JSON content type, otherwise 415 `{ error: "Send JSON." }`. When the limiter refuses a request: 429 `{ error: "Slow down a little, then try again." }`. Order of the guards: rate limit, then JSON only, then the existing 32 KB body limit.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/demoSlackClient.test.ts`, in "records views, responses and statuses in order, per session", change the two expected status payloads from `userToken: "xoxp-demo-U_DANA"` to `slackUserId: "U_DANA"` (the arguments passed to `setUserStatus` and `clearUserStatus` stay as they are). Add:

```ts
it("records whose status it is, never the token", async () => {
  const db = createTestDb();
  const slack = new DemoSlackClient(db, "S1", () => 1);
  await slack.setUserStatus({ userToken: "xoxp-demo-U_NOA", text: "Out", emoji: ":x:", expiration: 0 });
  await slack.clearUserStatus({ userToken: "something-else" });
  const payloads = (await readDemoEvents(db, "S1")).map((e) => e.payload);
  expect(JSON.parse(payloads[0] ?? "{}")).toMatchObject({ slackUserId: "U_NOA" });
  expect(JSON.parse(payloads[1] ?? "{}")).toEqual({ slackUserId: "unknown", status: null });
  expect(payloads.join("")).not.toContain("xoxp");
});
```

In `apps/worker/test/demo.test.ts`, in the full-flow test, change the expected status payload from `userToken: "xoxp-demo-U_DANA"` to `slackUserId: "U_DANA"`, and at the end of that test add `expect(JSON.stringify(state)).not.toContain("xoxp");`. Add to `describe("/demo", ...)`:

```ts
it("accepts JSON only", async () => {
  const app = createApp(testDeps());
  const form = await app.request("/demo/sessions", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "tz=UTC",
  });
  expect(form.status).toBe(415);
  expect(await form.json()).toEqual({ error: "Send JSON." });
  const untyped = await app.request("/demo/sessions", { method: "POST", body: "{}" });
  expect(untyped.status).toBe(415);
});

it("turns away a visitor who is sending requests too fast, and nobody else", async () => {
  const seen: string[] = [];
  const deps = testDeps({
    demoLimiter: {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: key !== "203.0.113.9" };
      },
    },
  });
  const app = createApp(deps);
  const from = (ip: string) =>
    app.request("/demo/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: "{}",
    });
  const refused = await from("203.0.113.9");
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: "Slow down a little, then try again." });
  expect((await from("198.51.100.7")).status).toBe(201);
  expect(seen).toEqual(["203.0.113.9", "198.51.100.7"]);
  expect(await deps.db.select().from(schema.demoSessions)).toHaveLength(1);
});

it("lets visitors through when the limiter itself fails", async () => {
  const deps = testDeps({
    demoLimiter: {
      limit: async () => {
        throw new Error("limiter down");
      },
    },
  });
  expect((await post(createApp(deps), "/demo/sessions", {})).status).toBe(201);
});
```

If an existing test in that file posts to `/demo` without a JSON content type on purpose (a malformed body, for instance), give that request the header `"content-type": "application/json"`; the body stays as it is.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test`
Expected: the changed and new tests fail (payloads still carry `userToken`; the form post answers 201; `demoLimiter` is not a known field); everything else passes.

- [ ] **Step 3: Name the person in status events**

In `apps/worker/src/demo/slackClient.ts`, add above the class:

```ts
/** Demo people's user tokens are this prefix plus their Slack user id (session.ts seals them that way). */
export const DEMO_USER_TOKEN_PREFIX = "xoxp-demo-";

/** Whose token this is. The recorded state names the person and never carries the token. */
const userOf = (userToken: string): string =>
  userToken.startsWith(DEMO_USER_TOKEN_PREFIX)
    ? userToken.slice(DEMO_USER_TOKEN_PREFIX.length)
    : "unknown";
```

and change the two status methods to:

```ts
  async setUserStatus(args: SetStatusArgs): Promise<void> {
    await this.record("status", {
      slackUserId: userOf(args.userToken),
      status: { text: args.text, emoji: args.emoji, expiration: args.expiration },
    });
  }

  async clearUserStatus(args: { userToken: string }): Promise<void> {
    await this.record("status", { slackUserId: userOf(args.userToken), status: null });
  }
```

In `apps/worker/src/demo/session.ts`, import `DEMO_USER_TOKEN_PREFIX` alongside `DemoSlackClient` and seal each person's token as `` `${DEMO_USER_TOKEN_PREFIX}${p.slackUserId}` `` instead of the literal `xoxp-demo-` string.

- [ ] **Step 4: Rate limit and JSON only**

`apps/worker/src/env.ts`: add above `Env`

```ts
/** Cloudflare's rate limiting binding, as far as the demo uses it. */
export type DemoLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
```

and inside `Env`:

```ts
  /** Per-visitor rate limit for /demo/* (the `[[ratelimits]]` binding in wrangler.toml). */
  DEMO_LIMITER?: DemoLimiter;
```

`apps/worker/src/deps.ts`: import `DemoLimiter` with `Env`, add to `Deps`

```ts
  /** Per-visitor rate limit for /demo/*. Absent when the binding is not configured. */
  demoLimiter?: DemoLimiter;
```

and to `depsFromEnv`: `demoLimiter: env.DEMO_LIMITER,`.

`apps/worker/src/routes/demo.ts`: inside `demoRoutes`, before the existing body-limit middleware:

```ts
  // One visitor may not hammer the demo. The key is the address Cloudflare saw the request come from.
  // A limiter that fails lets the request through: the write budget is the hard limit, this is the polite one.
  r.use("*", async (c, next) => {
    if (deps.demoLimiter) {
      const key = c.req.header("cf-connecting-ip") ?? "unknown";
      let allowed = true;
      try {
        allowed = (await deps.demoLimiter.limit({ key })).success;
      } catch (err) {
        console.error("demo rate limiter failed", { err });
      }
      if (!allowed) return c.json({ error: "Slow down a little, then try again." }, 429);
    }
    await next();
  });

  // A page on another site can make a visitor's browser send form-typed POSTs without asking first.
  // The demo takes JSON only, which a browser will not send cross-site without permission.
  r.use("*", async (c, next) => {
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (c.req.method === "POST" && !type.startsWith("application/json"))
      return c.json({ error: "Send JSON." }, 415);
    await next();
  });
```

Append to `apps/worker/wrangler.toml`:

```toml
# Per-visitor rate limit for the public demo: 60 requests a minute from one address, counted per
# Cloudflare location.
[[ratelimits]]
name = "DEMO_LIMITER"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 6: Typecheck, lint, build, commit**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @steward/worker build`
Expected: all exit 0, and the dry-run build lists the `DEMO_LIMITER` binding. If this Wrangler version refuses the `[[ratelimits]]` table, stop and report the exact error rather than removing it.

```bash
git add apps/worker/src/demo/slackClient.ts apps/worker/src/demo/session.ts apps/worker/src/routes/demo.ts apps/worker/src/env.ts apps/worker/src/deps.ts apps/worker/wrangler.toml apps/worker/test/demoSlackClient.test.ts apps/worker/test/demo.test.ts
git commit -m "feat(demo): JSON only, a per-visitor rate limit, and state that names the person instead of carrying a token"
```

---

### Task 3: A tick that fits the database's limits

D1's free tier allows 50 queries per Worker invocation. Today the minute tick spends 7 per expired session and 1 per due undo window, so a busy hour would stop cleanup from finishing. This task makes both set-based: a fixed number of statements however much there is to do, and proves it on the real D1 driver.

**Files:**
- Modify: `apps/worker/src/demo/session.ts`, `apps/worker/src/tick.ts`, `apps/worker/src/index.ts`, `apps/worker/wrangler.toml`, `apps/worker/package.json`, `packages/core/src/testing.ts`, `packages/core/src/db/d1.smoke.test.ts`
- Test: `apps/worker/test/demo.d1.smoke.test.ts` (new)

**Interfaces:**
- Consumes: `createDemoSession`, `advanceDemoClock`, `demoWorkspaceId`, `DEMO_SESSION_TTL_MS`, `DEMO_ORPHAN_GRACE_MS`, `deleteDemoWorkspace` (kept for the failed-seed rollback), `schema.demoDays` (Task 1), `DemoSlackClient`, `readDemoEvents`, `runTick`, `createD1Db` (`apps/worker/src/db.ts`), `testDeps`, `NOW`.
- Produces:
  ```ts
  // packages/core/src/testing.ts
  /** Applies the committed migrations to a D1 database, statement by statement. Node only. */
  export async function applyD1Migrations(d1: D1Database): Promise<void>;
  ```
  Behaviour: `cleanupDemoSessions` issues at most 15 statements whatever the number of expired sessions; it also deletes demo events whose session row is gone and `demo_days` rows older than seven days; its return value is the number of expired sessions it found and removed. `expireUndoWindows` issues one statement. The scheduled handler logs the tick's result, and Workers Logs are on.

- [ ] **Step 1: Share the D1 migration helper and add Miniflare to the Worker's tests**

In `packages/core/src/testing.ts`, add `import fs from "node:fs";` and:

```ts
/** Applies the committed migrations to a D1 database, statement by statement, the way `wrangler d1 migrations apply` does. Node only. */
export async function applyD1Migrations(d1: D1Database): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      const statement = raw.replace(/\s+/g, " ").trim();
      if (statement) await d1.prepare(statement).run();
    }
  }
}
```

In `packages/core/src/db/d1.smoke.test.ts`, delete the local `applyMigrations` function and the imports only it used, and call `applyD1Migrations` imported from `../testing` instead. Add `"miniflare": "^4.20260730.0"` to the `devDependencies` of `apps/worker/package.json` (the same range `packages/core` uses) and run `pnpm install`.

Run: `pnpm test`
Expected: all pass, the core D1 smoke test included.

- [ ] **Step 2: Write the failing test**

`apps/worker/test/demo.d1.smoke.test.ts`:

```ts
import { schema, upsertWorkspace } from "@steward/core";
import { applyD1Migrations } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createD1Db } from "../src/db";
import {
  advanceDemoClock,
  createDemoSession,
  DEMO_SESSION_TTL_MS,
  demoWorkspaceId,
} from "../src/demo/session";
import { DemoSlackClient, readDemoEvents } from "../src/demo/slackClient";
import { runTick } from "../src/tick";
import { NOW, type TestDeps, testDeps } from "./helpers";

describe("the demo on the real D1 driver (Miniflare)", () => {
  let mf: Miniflare;
  let deps: TestDeps;
  let queries = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "steward-demo-smoke" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyD1Migrations(d1);
    // Count every statement the code prepares: this is what D1 counts per invocation.
    const counted = new Proxy(d1, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        if (prop !== "prepare") return value.bind(target);
        return (query: string) => {
          queries++;
          return target.prepare(query);
        };
      },
    });
    deps = { ...testDeps(), db: createD1Db(counted) };
  }, 90_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("numbers a session's events without repeats when calls race", async () => {
    const slack = new DemoSlackClient(deps.db, "race", () => NOW);
    await Promise.all(Array.from({ length: 6 }, () => slack.clearUserStatus({ userToken: "t" })));
    expect((await readDemoEvents(deps.db, "race")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 60_000);

  it("counts the day's sessions exactly and adds up clock advances when requests race", async () => {
    const created = await Promise.all(Array.from({ length: 5 }, () => createDemoSession(deps, {})));
    const first = created[0];
    if (!first || "error" in first) throw new Error("unexpected busy");
    const day = new Date(NOW).toISOString().slice(0, 10);
    const [budget] = await deps.db.select().from(schema.demoDays).where(eq(schema.demoDays.day, day));
    expect(budget?.sessions).toBe(5);

    await Promise.all([1, 2, 3].map(() => advanceDemoClock(deps, first, 10 * 60 * 1000)));
    const [row] = await deps.db
      .select()
      .from(schema.demoSessions)
      .where(eq(schema.demoSessions.id, first.id));
    expect(row?.clockOffsetMs).toBe(30 * 60 * 1000);
  }, 60_000);

  it("cleans up any number of expired sessions in a fixed number of queries, and leaves the rest", async () => {
    // The five sessions above expire at NOW + TTL. Around them: a fresh session with an event, an old
    // and a young session-less demo workspace, a real workspace, a stray event, an old budget row.
    const later = NOW + DEMO_SESSION_TTL_MS + 1;
    deps.clock.now = later - 60_000;
    const fresh = await createDemoSession(deps, {});
    if ("error" in fresh) throw new Error("unexpected busy");
    await new DemoSlackClient(deps.db, fresh.id, () => later).clearUserStatus({ userToken: "t" });
    const workspace = (id: string, installedAt: number) =>
      upsertWorkspace(deps.db, { id, name: "x", botTokenSealed: "sealed", botUserId: "UB", installedAt });
    await workspace("demo:old-orphan", NOW);
    await workspace("demo:young-orphan", later - 1000);
    await workspace("T_REAL", 1);
    await deps.db.insert(schema.demoDays).values({ day: "2026-01-01", sessions: 9 });

    deps.clock.now = later;
    queries = 0;
    const result = await runTick(deps);
    expect(result.demoSessionsRemoved).toBe(5);
    expect(queries).toBeLessThanOrEqual(20);

    const ids = (await deps.db.select({ id: schema.workspaces.id }).from(schema.workspaces)).map((w) => w.id);
    expect(ids.sort()).toEqual(["T_REAL", "demo:young-orphan", demoWorkspaceId(fresh.id)].sort());
    expect((await deps.db.select().from(schema.demoSessions)).map((s) => s.id)).toEqual([fresh.id]);
    // The "race" events of the first test have no session: they are swept. The fresh session's event stays.
    expect((await deps.db.select().from(schema.demoEvents)).map((e) => e.sessionId)).toEqual([fresh.id]);
    expect(await deps.db.select().from(schema.people)).toHaveLength(3);
    expect((await deps.db.select().from(schema.demoDays)).map((d) => d.day)).not.toContain("2026-01-01");
  }, 60_000);
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `pnpm test`
Expected: the first two smoke tests pass (Task 1 and the earlier fix made them true); the third fails on `queries` (about 40, not 20 or fewer), on the stray events and on the old budget row.

- [ ] **Step 4: Make cleanup set-based**

In `apps/worker/src/demo/session.ts`, add `type SQL` to the `drizzle-orm` import, add the constant

```ts
/** Budget rows (`demo_days`) older than this are deleted by cleanup. */
const DEMO_DAY_ROWS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
```

and replace `cleanupDemoSessions` with:

```ts
/**
 * Deletes everything owned by the workspaces a subquery names: five statements, however many
 * workspaces there are. `workspaceIds` is a parenthesised select of workspace ids.
 */
async function deleteOwnedBy(db: Db, workspaceIds: SQL): Promise<void> {
  await db
    .delete(schema.statusTargets)
    .where(
      inArray(
        schema.statusTargets.statusId,
        db
          .select({ id: schema.statuses.id })
          .from(schema.statuses)
          .where(inArray(schema.statuses.workspaceId, workspaceIds)),
      ),
    );
  await db.delete(schema.statuses).where(inArray(schema.statuses.workspaceId, workspaceIds));
  await db.delete(schema.audit).where(inArray(schema.audit.workspaceId, workspaceIds));
  await db.delete(schema.people).where(inArray(schema.people.workspaceId, workspaceIds));
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
}

/**
 * Deletes every expired session with all the rows its workspace owns, then sweeps what was left
 * behind: demo workspaces without a session row that are older than the grace (a seed that died
 * half way), events whose session is gone, and old budget rows. A fixed number of statements
 * (at most 15) however much there is to delete, because D1 limits the queries of one invocation.
 * Returns how many expired sessions went.
 */
export async function cleanupDemoSessions(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const now = deps.now();
  const sessions = schema.demoSessions;
  const workspaces = schema.workspaces;
  const expired = lte(sessions.expiresAt, now);

  const [row] = await deps.db.select({ n: count() }).from(sessions).where(expired);
  const removed = row?.n ?? 0;
  if (removed > 0) {
    await deleteOwnedBy(
      deps.db,
      sql`(select 'demo:' || ${sessions.id} from ${sessions} where ${sessions.expiresAt} <= ${now})`,
    );
    await deps.db
      .delete(schema.demoEvents)
      .where(
        inArray(
          schema.demoEvents.sessionId,
          sql`(select ${sessions.id} from ${sessions} where ${sessions.expiresAt} <= ${now})`,
        ),
      );
    await deps.db.delete(sessions).where(expired);
  }

  try {
    await deleteOwnedBy(
      deps.db,
      sql`(select ${workspaces.id} from ${workspaces} where ${workspaces.id} like 'demo:%' and ${workspaces.installedAt} <= ${now - DEMO_ORPHAN_GRACE_MS} and ${workspaces.id} not in (select 'demo:' || ${sessions.id} from ${sessions}))`,
    );
    // Events are only ever written for a session that exists, so an event without one is safe to delete.
    await deps.db
      .delete(schema.demoEvents)
      .where(notInArray(schema.demoEvents.sessionId, sql`(select ${sessions.id} from ${sessions})`));
    await deps.db
      .delete(schema.demoDays)
      .where(lt(schema.demoDays.day, new Date(now - DEMO_DAY_ROWS_KEPT_MS).toISOString().slice(0, 10)));
  } catch (err) {
    console.error("demo sweep failed", { err });
  }
  return removed;
}
```

Remove the imports this leaves unused (`like`, if nothing else uses it). `deleteDemoWorkspace` stays as it is: the failed-seed rollback still calls it.

- [ ] **Step 5: Close undo windows in one statement, and log what the tick did**

In `apps/worker/src/tick.ts`, replace `expireUndoWindows` with (and drop the `eq` import if it is now unused):

```ts
/** Undo windows that have passed are closed so the card stops offering Undo. One statement, whatever the number. */
export async function expireUndoWindows(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const closed = await deps.db
    .update(schema.statuses)
    .set({ undoUntilMs: null })
    .where(and(isNotNull(schema.statuses.undoUntilMs), lt(schema.statuses.undoUntilMs, deps.now())))
    .returning({ id: schema.statuses.id });
  return closed.length;
}
```

In `apps/worker/src/index.ts`, the body of `scheduled` becomes:

```ts
    ctx.waitUntil(
      runTick(depsFromEnv(env, ctx)).then(
        (result) => console.log("tick", result),
        (err) => console.error("tick failed", { err }),
      ),
    );
```

Append to `apps/worker/wrangler.toml`:

```toml
# Workers Logs: the tick's one line a minute and every console.error are kept and searchable.
[observability]
enabled = true
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass, including the three D1 smoke tests and the existing cleanup tests in `demoSession.test.ts` and `tick.test.ts` (they describe behaviour, which has not changed, apart from stray events now being swept).

- [ ] **Step 7: Typecheck, lint, build, commit**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @steward/worker build`
Expected: all exit 0.

```bash
git add apps/worker/src/demo/session.ts apps/worker/src/tick.ts apps/worker/src/index.ts apps/worker/wrangler.toml apps/worker/package.json pnpm-lock.yaml apps/worker/test/demo.d1.smoke.test.ts packages/core/src/testing.ts packages/core/src/db/d1.smoke.test.ts
git commit -m "feat(tick): cleanup and undo expiry in a fixed number of statements, proven on D1; the tick logs what it did"
```
---

### Task 4: The web app's skeleton, built by Vite and served by the Worker

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `apps/web/src/route.ts`, `apps/web/src/route.test.ts`, `apps/web/src/pages/Product.tsx`, `apps/web/src/pages/Product.test.tsx`, `apps/web/src/pages/Try.tsx`
- Modify: `package.json`, `vitest.config.ts`, `tsconfig.base.json`, `packages/core/package.json`, `apps/worker/wrangler.toml`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: `pageFor(pathname: string): "product" | "try"` from `apps/web/src/route.ts`; components `Product` and `Try` (named exports) that later tasks replace the bodies of; the import path `@steward/core/blocks`; root scripts `pnpm build` and a `typecheck` that covers `apps/web`; web test files run under jsdom when their first line is `// @vitest-environment jsdom`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pageFor } from "./route";

describe("pageFor", () => {
  it("sends /try to the emulator and everything else to the product page", () => {
    expect(pageFor("/try")).toBe("try");
    expect(pageFor("/try/")).toBe("try");
    expect(pageFor("/")).toBe("product");
    expect(pageFor("/anything-else")).toBe("product");
    expect(pageFor("/trying")).toBe("product");
  });
});
```

`apps/web/src/pages/Product.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Product } from "./Product";

afterEach(cleanup);

describe("Product page", () => {
  it("names the product and links to the demo", () => {
    render(<Product />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Steward");
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe("/try");
  });
});
```

- [ ] **Step 2: Wire the workspace so those tests can run**

`apps/web/package.json`:

```json
{
  "name": "@steward/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@steward/core": "workspace:*",
    "@tailwindcss/vite": "^4.3.0",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.3.0",
    "tailwindcss": "^4.3.0",
    "vite": "^8.3.0"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

Root `package.json`: add the script `"build": "pnpm --filter @steward/web build && pnpm --filter @steward/worker build"`; append ` && tsc --noEmit -p apps/web` to the `typecheck` script; add `"jsdom": "^31.0.0"` to the root `devDependencies` (Vitest runs from the root and loads the jsdom environment from there).

`tsconfig.base.json`: add to `paths`, before the `@steward/core` entry:

```json
"@steward/core/blocks": ["./packages/core/src/slack/blocks.ts"],
```

`packages/core/package.json`: add to `exports`:

```json
"./blocks": "./src/slack/blocks.ts"
```

`vitest.config.ts` becomes:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@steward/core/testing": path.resolve(__dirname, "packages/core/src/testing.ts"),
      "@steward/core/blocks": path.resolve(__dirname, "packages/core/src/slack/blocks.ts"),
      "@steward/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@steward/availability": path.resolve(__dirname, "packages/availability/src/index.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "apps/*/test/**/*.test.ts",
    ],
  },
});
```

Run `pnpm install`.

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm test`
Expected: the two new files fail with "Cannot find module './route'" and "'./Product'"; the existing tests pass.

- [ ] **Step 4: Write the skeleton**

`apps/web/src/route.ts`:

```ts
export type Page = "product" | "try";

/** Two pages and no router: the Worker serves index.html for every path that is not an API route. */
export function pageFor(pathname: string): Page {
  return pathname.replace(/\/+$/, "") === "/try" ? "try" : "product";
}
```

`apps/web/src/pages/Product.tsx` (Task 8 writes the real page):

```tsx
export function Product() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-bold">Steward</h1>
      <p className="mt-4">
        <a className="underline" href="/try">
          Try the demo
        </a>
      </p>
    </main>
  );
}
```

`apps/web/src/pages/Try.tsx` (Task 7 mounts the emulator here):

```tsx
export function Try() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-bold">Steward demo</h1>
    </main>
  );
}
```

`apps/web/src/index.css`:

```css
@import "tailwindcss";
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Product } from "./pages/Product";
import { Try } from "./pages/Try";
import { pageFor } from "./route";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>{pageFor(window.location.pathname) === "try" ? <Try /> : <Product />}</StrictMode>,
);
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      name="description"
      content="Steward Availability: say once that you're out. It sets your status, shows you what it did, and lets you undo it."
    />
    <title>Steward · Availability</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm --filter @steward/worker dev` serves the API here while `vite` serves the pages.
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/demo": worker, "/oauth": worker, "/slack": worker, "/health": worker } },
  build: { outDir: "dist", emptyOutDir: true },
});
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass, including `route.test.ts` and `Product.test.tsx`.

- [ ] **Step 6: Serve the built pages from the Worker**

Append to `apps/worker/wrangler.toml`:

```toml
# The web app (apps/web) is built to static files and served from here. API paths always reach
# the Worker; any other path that is not a file falls back to index.html.
[assets]
directory = "../web/dist"
not_found_handling = "single-page-application"
run_worker_first = ["/slack/*", "/oauth/*", "/demo/*", "/health"]
```

`.github/workflows/ci.yml`: in the `check` job replace `- run: pnpm --filter @steward/worker build` with `- run: pnpm build`; in the `deploy` job the last step's command becomes `pnpm --filter @steward/web build && pnpm --filter @steward/worker db:migrate:remote && pnpm --filter @steward/worker release`.

`README.md`, in "Develop", after the existing commands add:

```bash
pnpm --filter @steward/web dev              # http://localhost:5173 (pages; proxies the API to :8787)
pnpm build                                  # web to apps/web/dist, then a dry-run Worker build that includes it
```

and one sentence under the block: "The Worker serves the built pages itself, so `pnpm --filter @steward/worker dev` needs `pnpm --filter @steward/web build` to have run once."

- [ ] **Step 7: Verify the whole chain**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all exit 0; `apps/web/dist/index.html` exists; Wrangler's dry-run output mentions the assets directory.

Run: `grep -l "drizzle" apps/web/dist/assets/*.js; echo "exit $?"`
Expected: no file listed and `exit 1` (the browser bundle contains no server code).

- [ ] **Step 8: Commit**

```bash
git add apps/web package.json pnpm-lock.yaml vitest.config.ts tsconfig.base.json packages/core/package.json apps/worker/wrangler.toml .github/workflows/ci.yml README.md
git commit -m "feat(web): a React app built by Vite and served by the Worker; API paths reach the Worker first"
```

---

### Task 5: The Block Kit renderer

**Files:**
- Create: `apps/web/src/blockkit/emoji.ts`, `apps/web/src/blockkit/mrkdwn.tsx`, `apps/web/src/blockkit/values.ts`, `apps/web/src/blockkit/Blocks.tsx`, `apps/web/src/blockkit/Modal.tsx`
- Test: `apps/web/src/blockkit/mrkdwn.test.tsx`, `apps/web/src/blockkit/Blocks.test.tsx`, `apps/web/src/blockkit/Modal.test.tsx`

**Interfaces:**
- Consumes: the types `Block`, `Element`, `ModalView`, `TextObject` and the builders (`header`, `section`, `actions`, `button`, `context`, `divider`, `input`, `staticSelect`, `datepicker`, `textInput`, `option`, `plain`) from `@steward/core/blocks`.
- Produces:
  ```ts
  // emoji.ts
  export function emojify(text: string): string;
  // mrkdwn.tsx
  export function mrkdwn(source: string): ReactNode[];
  // values.ts (pure: no React)
  export type Values = Record<string, string>; // keyed by input block_id; "" means empty
  export function initialValues(view: ModalView): Values;
  // Blocks.tsx
  export type BlockAction = { action_id: string; value?: string };
  export function Blocks(props: { blocks: Block[]; onAction?: (a: BlockAction) => void; disabled?: boolean }): JSX.Element;
  export function Unsupported(props: { what: "block" | "element"; type: string }): JSX.Element;
  // Modal.tsx
  export function Modal(props: {
    view: ModalView; values: Values; errors: Record<string, string>; busy: boolean;
    onChange: (blockId: string, value: string) => void; onSubmit: () => void; onClose: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/blockkit/mrkdwn.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mrkdwn } from "./mrkdwn";

afterEach(cleanup);

describe("mrkdwn", () => {
  it("renders bold, italic, code, line breaks and the product's emoji", () => {
    const { container } = render(
      <p>{mrkdwn("✅ *Slack status* set — clears _Tue_\n`/ooo` :palm_tree: :shrug:")}</p>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Slack status");
    expect(container.querySelector("em")?.textContent).toBe("Tue");
    expect(container.querySelector("code")?.textContent).toBe("/ooo");
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.textContent).toContain("🌴");
    expect(container.textContent).toContain(":shrug:"); // not one of the product's: shown as typed
  });

  it("treats markup in the text as text", () => {
    const { container } = render(<p>{mrkdwn("<img src=x onerror=alert(1)> & more")}</p>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("<img src=x onerror=alert(1)> & more");
  });
});
```

`apps/web/src/blockkit/Blocks.test.tsx`:

```tsx
// @vitest-environment jsdom
import { actions, type Block, button, context, divider, header, section } from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Blocks } from "./Blocks";

afterEach(cleanup);

const receipt: Block[] = [
  header("Out of office · Thu 12 Nov"),
  section("✅ Slack status set — clears Thu 12 Nov"),
  actions(button("Undo", "status_undo", { value: "st_1", style: "danger" })),
  context("You can undo until 10:05."),
];

describe("Blocks", () => {
  it("renders a receipt and reports the button that was pressed", () => {
    const onAction = vi.fn();
    render(<Blocks blocks={receipt} onAction={onAction} />);
    expect(screen.getByRole("heading", { name: "Out of office · Thu 12 Nov" })).toBeTruthy();
    expect(screen.getByText("✅ Slack status set — clears Thu 12 Nov")).toBeTruthy();
    expect(screen.getByText("You can undo until 10:05.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledWith({ action_id: "status_undo", value: "st_1" });
  });

  it("disables buttons while a request is in flight", () => {
    render(<Blocks blocks={receipt} disabled />);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders section fields, a divider and a link button", () => {
    const blocks: Block[] = [
      { type: "section", fields: [{ type: "mrkdwn", text: "*From*" }, { type: "plain_text", text: "Thu" }] },
      divider(),
      actions(button("Docs", "docs", { url: "https://example.com/docs" })),
    ];
    const { container } = render(<Blocks blocks={blocks} />);
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("Thu")).toBeTruthy();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("https://example.com/docs");
  });

  it("shows unknown blocks and elements instead of hiding them", () => {
    const blocks = [
      { type: "image", image_url: "https://example.com/x.png" },
      { type: "actions", elements: [{ type: "overflow", action_id: "more" }] },
    ] as unknown as Block[];
    render(<Blocks blocks={blocks} />);
    expect(screen.getByText("unsupported block: image")).toBeTruthy();
    expect(screen.getByText("unsupported element: overflow")).toBeTruthy();
  });
});
```

`apps/web/src/blockkit/Modal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { datepicker, input, type ModalView, option, plain, staticSelect, textInput } from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";
import { initialValues } from "./values";

afterEach(cleanup);

/** The same shape as the product's status form. */
const view: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  submit: plain("Save"),
  close: plain("Cancel"),
  blocks: [
    input("type", "What's happening?", staticSelect("type", [option("Out of office", "out"), option("Sick", "sick")], option("Out of office", "out"))),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("to", "To (last day)", datepicker("to", "2026-11-12")),
    input("text", "Status text", textInput("text", "Out of office"), true),
    input("emoji", "Emoji", textInput("emoji", ":palm_tree:", ":palm_tree:"), true),
  ],
};

function show(over: Partial<Parameters<typeof Modal>[0]> = {}) {
  const props = {
    view,
    values: initialValues(view),
    errors: {},
    busy: false,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<Modal {...props} />);
  return props;
}

describe("initialValues", () => {
  it("reads every input block's starting value", () => {
    expect(initialValues(view)).toEqual({
      type: "out",
      from: "2026-11-12",
      to: "2026-11-12",
      text: "Out of office",
      emoji: ":palm_tree:",
    });
  });
});

describe("Modal", () => {
  it("is a labelled dialog whose fields carry the form's values", () => {
    show();
    expect(screen.getByRole("dialog", { name: "Set your availability" })).toBeTruthy();
    expect((screen.getByLabelText("What's happening?") as HTMLSelectElement).value).toBe("out");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-11-12");
    expect((screen.getByLabelText(/Status text/) as HTMLInputElement).value).toBe("Out of office");
  });

  it("reports edits, submit and both ways of closing", () => {
    const props = show();
    fireEvent.change(screen.getByLabelText("To (last day)"), { target: { value: "2026-11-13" } });
    expect(props.onChange).toHaveBeenCalledWith("to", "2026-11-13");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("shows each error under its field, and an error for no field at the top", () => {
    show({ errors: { to: "The last day has already passed.", nowhere: "Steward couldn't reach its records." } });
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts).toContain("The last day has already passed.");
    expect(alerts).toContain("Steward couldn't reach its records.");
  });

  it("disables Save while busy and shows an unknown element instead of hiding it", () => {
    const odd = {
      ...view,
      blocks: [...view.blocks, { type: "input", block_id: "who", label: plain("Who"), element: { type: "multi_users_select", action_id: "who" } }],
    } as unknown as ModalView;
    show({ view: odd, busy: true });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("unsupported element: multi_users_select")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test`
Expected: the three new files fail on missing modules; everything else passes.

- [ ] **Step 3: Write the renderer**

`apps/web/src/blockkit/emoji.ts`:

```ts
/** The shortcodes the product's own copy uses. Anything else is shown as typed. */
const EMOJI: Record<string, string> = {
  palm_tree: "🌴",
  face_with_thermometer: "🤒",
  house: "🏠",
  airplane: "✈️",
};

export function emojify(text: string): string {
  return text.replace(/:([a-z0-9_+'-]+):/g, (whole, name: string) => EMOJI[name] ?? whole);
}
```

`apps/web/src/blockkit/mrkdwn.tsx`:

```tsx
import type { ReactNode } from "react";
import { emojify } from "./emoji";

const TOKEN = /(\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\n)/;
const wrapped = (part: string, mark: string) =>
  part.length > 2 && part.startsWith(mark) && part.endsWith(mark);

/** Slack mrkdwn as far as the product uses it: *bold*, _italic_, `code`, line breaks, :emoji:. */
export function mrkdwn(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const part of emojify(source).split(TOKEN)) {
    if (part === "") continue;
    const key = offset;
    offset += part.length;
    const inner = part.slice(1, -1);
    if (part === "\n") nodes.push(<br key={key} />);
    else if (wrapped(part, "*")) nodes.push(<strong key={key}>{inner}</strong>);
    else if (wrapped(part, "_")) nodes.push(<em key={key}>{inner}</em>);
    else if (wrapped(part, "`"))
      nodes.push(
        <code key={key} className="rounded bg-black/10 px-1 text-[0.9em] dark:bg-white/10">
          {inner}
        </code>,
      );
    else nodes.push(<span key={key}>{part}</span>);
  }
  return nodes;
}
```

`apps/web/src/blockkit/values.ts`:

```ts
import type { ModalView } from "@steward/core/blocks";

/** A modal's field values, keyed by input block_id. "" means empty. */
export type Values = Record<string, string>;

export function initialValues(view: ModalView): Values {
  const values: Values = {};
  for (const block of view.blocks) {
    if (block.type !== "input") continue;
    const el = block.element;
    if (el.type === "static_select") values[block.block_id] = el.initial_option?.value ?? "";
    else if (el.type === "datepicker") values[block.block_id] = el.initial_date ?? "";
    else if (el.type === "plain_text_input") values[block.block_id] = el.initial_value ?? "";
  }
  return values;
}
```

`apps/web/src/blockkit/Blocks.tsx`:

```tsx
import type { Block, Element, TextObject } from "@steward/core/blocks";
import type { ReactNode } from "react";
import { emojify } from "./emoji";
import { mrkdwn } from "./mrkdwn";

export type BlockAction = { action_id: string; value?: string };
type OnAction = (action: BlockAction) => void;

const textOf = (t: TextObject): ReactNode =>
  t.type === "mrkdwn" ? mrkdwn(t.text) : emojify(t.text);

export function Unsupported({ what, type }: { what: "block" | "element"; type: string }) {
  return (
    <div
      role="note"
      className="my-1 rounded border border-dashed border-rose-500 px-2 py-1 text-sm text-rose-600"
    >
      unsupported {what}: {type}
    </div>
  );
}

const BUTTON = "inline-block rounded border px-3 py-1 text-sm font-bold disabled:opacity-50";
const BUTTON_STYLE = {
  default: "border-neutral-400 bg-white text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100",
  primary: "border-emerald-700 bg-emerald-700 text-white",
  danger: "border-rose-600 bg-white text-rose-600 dark:bg-neutral-800",
} as const;

function ActionElement(props: { el: Element; onAction?: OnAction; disabled?: boolean }) {
  const { el, onAction, disabled } = props;
  if (el.type !== "button") return <Unsupported what="element" type={el.type} />;
  const className = `${BUTTON} ${BUTTON_STYLE[el.style ?? "default"]}`;
  if (el.url)
    return (
      <a className={className} href={el.url} target="_blank" rel="noreferrer">
        {emojify(el.text.text)}
      </a>
    );
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => onAction?.({ action_id: el.action_id, value: el.value })}
    >
      {emojify(el.text.text)}
    </button>
  );
}

function BlockView(props: { block: Block; onAction?: OnAction; disabled?: boolean }) {
  const { block, onAction, disabled } = props;
  switch (block.type) {
    case "header":
      return <h3 className="text-base font-extrabold">{emojify(block.text.text)}</h3>;
    case "section":
      return (
        <div>
          {block.text ? <p>{textOf(block.text)}</p> : null}
          {block.fields ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {block.fields.map((field, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a block's fields are a fixed list that never reorders
                <p key={i}>{textOf(field)}</p>
              ))}
            </div>
          ) : null}
          {block.accessory ? (
            <div className="mt-1">
              <ActionElement el={block.accessory} onAction={onAction} disabled={disabled} />
            </div>
          ) : null}
        </div>
      );
    case "context":
      return (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {block.elements.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a block's elements are a fixed list that never reorders
            <span key={i} className="mr-2">
              {textOf(t)}
            </span>
          ))}
        </p>
      );
    case "divider":
      return <hr className="my-2 border-neutral-300 dark:border-neutral-700" />;
    case "actions":
      return (
        <div className="flex flex-wrap gap-2 pt-1">
          {block.elements.map((el, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a block's elements are a fixed list that never reorders
            <ActionElement key={i} el={el} onAction={onAction} disabled={disabled} />
          ))}
        </div>
      );
    default:
      // Input blocks belong to modals; anything else is a block this renderer does not know yet.
      return <Unsupported what="block" type={(block as { type: string }).type} />;
  }
}

export function Blocks(props: { blocks: Block[]; onAction?: OnAction; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      {props.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a message's blocks are a fixed list that never reorders
        <BlockView key={i} block={block} onAction={props.onAction} disabled={props.disabled} />
      ))}
    </div>
  );
}
```

`apps/web/src/blockkit/Modal.tsx`:

```tsx
import type { Element, ModalView } from "@steward/core/blocks";
import { useEffect, useId } from "react";
import { Blocks, Unsupported } from "./Blocks";
import { emojify } from "./emoji";
import type { Values } from "./values";

const FIELD =
  "w-full rounded border border-neutral-400 bg-white px-2 py-1.5 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";
const FOOT_BUTTON = "rounded border px-3 py-1.5 text-sm font-bold disabled:opacity-50";

function InputElement(props: { id: string; el: Element; value: string; onChange: (v: string) => void }) {
  const { id, el, value, onChange } = props;
  if (el.type === "static_select")
    return (
      <select id={id} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)}>
        {value === "" ? <option value="">{el.placeholder?.text ?? "Choose…"}</option> : null}
        {el.options.map((o) => (
          <option key={o.value} value={o.value}>
            {emojify(o.text.text)}
          </option>
        ))}
      </select>
    );
  if (el.type === "datepicker")
    return (
      <input id={id} className={FIELD} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    );
  if (el.type === "plain_text_input")
    return (
      <input
        id={id}
        className={FIELD}
        type="text"
        value={value}
        placeholder={el.placeholder?.text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <Unsupported what="element" type={(el as { type: string }).type} />;
}

export function Modal(props: {
  view: ModalView;
  values: Values;
  errors: Record<string, string>;
  busy: boolean;
  onChange: (blockId: string, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { view, values, errors, busy, onChange, onSubmit, onClose } = props;
  const titleId = useId();
  const fieldPrefix = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fieldIds = new Set(view.blocks.flatMap((b) => (b.type === "input" ? [b.block_id] : [])));
  const strayErrors = Object.entries(errors).filter(([blockId]) => !fieldIds.has(blockId));

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mt-10 w-full max-w-lg rounded-lg bg-white text-neutral-900 shadow-xl dark:bg-neutral-900 dark:text-neutral-100"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-700">
            <h2 id={titleId} className="text-lg font-bold">
              {emojify(view.title.text)}
            </h2>
            <button type="button" aria-label="Close" className="px-2 text-neutral-500" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="space-y-4 px-5 py-4">
            {strayErrors.map(([blockId, message]) => (
              <p key={blockId} role="alert" className="text-sm text-rose-600">
                {message}
              </p>
            ))}
            {view.blocks.map((block, i) => {
              if (block.type !== "input")
                // biome-ignore lint/suspicious/noArrayIndexKey: a view's blocks are a fixed list that never reorders
                return <Blocks key={i} blocks={[block]} />;
              const id = `${fieldPrefix}-${block.block_id}`;
              const error = errors[block.block_id];
              return (
                <div key={block.block_id}>
                  <label htmlFor={id} className="mb-1 block text-sm font-bold">
                    {emojify(block.label.text)}
                    {block.optional ? (
                      <span className="ml-1 font-normal text-neutral-500"> (optional)</span>
                    ) : null}
                  </label>
                  <InputElement
                    id={id}
                    el={block.element}
                    value={values[block.block_id] ?? ""}
                    onChange={(v) => onChange(block.block_id, v)}
                  />
                  {error ? (
                    <p role="alert" className="mt-1 text-sm text-rose-600">
                      {error}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-700">
            <button type="button" className={`${FOOT_BUTTON} border-neutral-400`} onClick={onClose}>
              {view.close?.text ?? "Cancel"}
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`${FOOT_BUTTON} border-emerald-700 bg-emerald-700 text-white`}
            >
              {view.submit?.text ?? "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0. If Biome reorders imports or reflows long lines, accept its formatting (`pnpm lint:fix`) and re-run.

```bash
git add apps/web/src/blockkit
git commit -m "feat(web): a Block Kit renderer for the blocks the product emits; unknown blocks are shown, never hidden"
```

---

### Task 6: The emulator's logic, proven against the real backend

**Files:**
- Create: `apps/web/src/demo/api.ts`, `apps/web/src/demo/model.ts`, `apps/web/src/demo/payloads.ts`
- Modify: `apps/worker/src/routes/demo.ts` (a response URL per source message), `apps/worker/test/demo.test.ts`
- Test: `apps/web/src/demo/model.test.ts`, `apps/web/src/demo/payloads.test.ts`, `apps/worker/test/webContract.test.ts`

**Interfaces:**
- Consumes: `Values`, `initialValues` from `apps/web/src/blockkit/values.ts`; `emojify` from `apps/web/src/blockkit/emoji.ts`; the backend's `/demo/*` routes; `createApp` and `testDeps` in the Worker's tests. This task's three source files stay free of React and of browser globals.
- Produces:
  ```ts
  // api.ts
  export type DemoPerson = { slackUserId: string; displayName: string; tz: string };
  export type DemoSessionInfo = { id: string; expiresAt: number; clockOffsetMs: number; you: DemoPerson | null; people: DemoPerson[] };
  export type SlackStatus = { text: string; emoji: string; expiration: number };
  export type DemoEvent =
    | { seq: number; kind: "view"; at: number; payload: { triggerId: string; view: ModalView } }
    | { seq: number; kind: "response"; at: number; payload: { responseUrl: string; text: string; blocks: Block[]; replaceOriginal: boolean } }
    | { seq: number; kind: "status"; at: number; payload: { slackUserId: string; status: SlackStatus | null } };
  export type DemoState = { now: number; expiresAt: number; clockOffsetMs: number; events: DemoEvent[] };
  export type SubmitAnswer = { response_action: "clear" } | { response_action: "errors"; errors: Record<string, string> };
  export class DemoGone extends Error {}   // 404: the session expired
  export class DemoBusy extends Error {}   // 429: too many live sessions
  export class DemoFailed extends Error {} // anything else; message is the backend's sentence when it sent one
  export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;
  export type DemoApi = {
    createSession(tz: string): Promise<DemoSessionInfo>;
    getState(id: string): Promise<DemoState>;
    sendCommand(id: string, text: string): Promise<{ text: string }>;
    interact(id: string, payload: unknown): Promise<SubmitAnswer | null>;
    advance(id: string, minutes: number): Promise<DemoState>;
  };
  export function demoApi(fetchFn: FetchFn): DemoApi;
  // model.ts
  export type Message = { seq: number; at: number; text: string; blocks: Block[] };
  export type Screen = { messages: Message[]; openView: { seq: number; view: ModalView } | null; statuses: Record<string, SlackStatus | null> };
  export function deriveScreen(state: Pick<DemoState, "now" | "events">, closedViews: ReadonlySet<number>): Screen;
  export type Notice = { id: number; afterSeq: number; text: string };
  export type ThreadItem = { kind: "message"; key: string; message: Message } | { kind: "notice"; key: string; text: string };
  export function thread(messages: Message[], notices: Notice[]): ThreadItem[];
  export function formatDay(epochMs: number, tz: string): string;      // "Thu 12 Nov"
  export function formatTime(epochMs: number, tz: string): string;     // "10:02"
  export function statusLine(status: SlackStatus | null | undefined, tz: string): string;
  // payloads.ts
  export function viewSubmission(view: ModalView, values: Values): { type: "view_submission"; view: unknown };
  export function blockAction(action: { action_id: string; value?: string }, messageSeq: number): { type: "block_actions"; container: unknown; actions: unknown[] };
  ```
- Backend contract added here: when an interaction carries `container.message_ts` made of 1 to 10 digits, the response URL the handlers see is `https://hooks.slack.com/demo/<session>/<message_ts>`; otherwise it stays `https://hooks.slack.com/demo/<session>`. The model reads the trailing number of a `replaceOriginal` response's URL as the `seq` of the message to replace.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("demoInteractionPayload", ...)` block in `apps/worker/test/demo.test.ts` (keep its existing tests; the block already defines `const session = { id: "S1", workspaceId: "W1" };`):

```ts
it("gives a button press its own response URL, named after the message it lives on", () => {
  const base = `https://hooks.slack.com/demo/${session.id}`;
  const url = (container: unknown) =>
    demoInteractionPayload({ type: "block_actions", container }, session, null).response_url;
  expect(url({ type: "message", message_ts: "3" })).toBe(`${base}/3`);
  expect(url({ type: "message", message_ts: "3/../../evil" })).toBe(base);
  expect(url({ type: "message", message_ts: "12345678901" })).toBe(base);
  expect(url({ type: "message", message_ts: 3 })).toBe(base);
  expect(url(undefined)).toBe(base);
});
```

`apps/web/src/demo/payloads.test.ts`:

```ts
import { datepicker, input, type ModalView, option, plain, staticSelect, textInput } from "@steward/core/blocks";
import { describe, expect, it } from "vitest";
import { blockAction, viewSubmission } from "./payloads";

const view: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  blocks: [
    input("type", "What's happening?", staticSelect("type", [option("Out of office", "out")])),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("text", "Status text", textInput("text"), true),
  ],
};

describe("payloads", () => {
  it("builds the view_submission Slack would send, with empty fields as null", () => {
    expect(viewSubmission(view, { type: "out", from: "2026-11-12", text: "" })).toEqual({
      type: "view_submission",
      view: {
        type: "modal",
        callback_id: "ooo_status",
        state: {
          values: {
            type: { type: { type: "static_select", selected_option: { value: "out" } } },
            from: { from: { type: "datepicker", selected_date: "2026-11-12" } },
            text: { text: { type: "plain_text_input", value: null } },
          },
        },
      },
    });
    expect(viewSubmission(view, {}).view).toMatchObject({
      state: { values: { type: { type: { selected_option: null } }, from: { from: { selected_date: null } } } },
    });
  });

  it("builds a block_actions payload that names the message the button lives on", () => {
    expect(blockAction({ action_id: "status_undo", value: "st_1" }, 3)).toEqual({
      type: "block_actions",
      container: { type: "message", message_ts: "3" },
      actions: [{ type: "button", action_id: "status_undo", value: "st_1" }],
    });
  });
});
```

`apps/web/src/demo/model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DemoEvent, SlackStatus } from "./api";
import { deriveScreen, statusLine, thread } from "./model";

// The id's last group is all digits on purpose: it must never be read as a message number.
const BASE = "https://hooks.slack.com/demo/3f2b8c1e-0000-4000-8000-123456789012";
const view = (seq: number): DemoEvent => ({
  seq,
  kind: "view",
  at: 1,
  payload: {
    triggerId: `t${seq}`,
    view: { type: "modal", callback_id: "ooo_status", title: { type: "plain_text", text: "Form" }, blocks: [] },
  },
});
const response = (seq: number, text: string, opts: { replace?: boolean; target?: number } = {}): DemoEvent => ({
  seq,
  kind: "response",
  at: seq * 1000,
  payload: {
    responseUrl: opts.target === undefined ? BASE : `${BASE}/${opts.target}`,
    text,
    blocks: [],
    replaceOriginal: opts.replace ?? false,
  },
});
const status = (seq: number, s: SlackStatus | null): DemoEvent => ({
  seq,
  kind: "status",
  at: 1,
  payload: { slackUserId: "U_DANA", status: s },
});
const none = new Set<number>();
const texts = (events: DemoEvent[]) =>
  deriveScreen({ now: 0, events }, none).messages.map((m) => `${m.seq}:${m.text}`);

describe("deriveScreen", () => {
  it("shows the newest form unless the visitor closed it", () => {
    const events = [view(1), view(4)];
    expect(deriveScreen({ now: 0, events }, none).openView?.seq).toBe(4);
    expect(deriveScreen({ now: 0, events }, new Set([1])).openView?.seq).toBe(4);
    expect(deriveScreen({ now: 0, events }, new Set([4])).openView).toBeNull();
  });

  it("appends receipts, and replaces the card a button lived on in place", () => {
    const events = [
      response(2, "A"),
      response(3, "B"),
      response(5, "That status was already replaced"),
      response(6, "Undone B", { replace: true, target: 3 }),
    ];
    expect(texts(events)).toEqual(["2:A", "3:Undone B", "5:That status was already replaced"]);
  });

  it("replaces the last message when the URL names none, and appends when there is nothing to replace", () => {
    expect(texts([response(2, "A"), response(3, "Undone A", { replace: true })])).toEqual(["2:Undone A"]);
    expect(texts([response(2, "Undone", { replace: true, target: 9 })])).toEqual(["2:Undone"]);
  });

  it("tracks a person's Slack status and clears it once its expiration passes", () => {
    const set = status(1, { text: "Out of office", emoji: ":palm_tree:", expiration: 2000 });
    expect(deriveScreen({ now: 1_999_999, events: [set] }, none).statuses.U_DANA?.text).toBe("Out of office");
    expect(deriveScreen({ now: 2_000_000, events: [set] }, none).statuses.U_DANA).toBeNull();
    expect(deriveScreen({ now: 0, events: [set, status(2, null)] }, none).statuses.U_DANA).toBeNull();
  });
});

describe("thread", () => {
  it("puts each notice after the message that was newest when it appeared", () => {
    const messages = [
      { seq: 3, at: 0, text: "m3", blocks: [] },
      { seq: 7, at: 0, text: "m7", blocks: [] },
    ];
    const notices = [
      { id: 1, afterSeq: 3, text: "n1" },
      { id: 2, afterSeq: 3, text: "n2" },
      { id: 3, afterSeq: 0, text: "first" },
    ];
    expect(thread(messages, notices).map((i) => i.key)).toEqual(["n3", "m3", "n1", "n2", "m7"]);
  });
});

describe("statusLine", () => {
  it("describes a status the way the side panel shows it", () => {
    const until = Date.UTC(2026, 10, 13, 0, 0) / 1000; // the midnight after Thu 12 Nov, in London
    expect(statusLine({ text: "Out of office", emoji: ":palm_tree:", expiration: until }, "Europe/London")).toBe(
      "🌴 Out of office · until Thu 12 Nov",
    );
    expect(statusLine(null, "Europe/London")).toBe("No status set");
  });
});
```

`apps/worker/test/webContract.test.ts`:

```ts
import type { Block } from "@steward/core";
import { describe, expect, it } from "vitest";
import { initialValues } from "../../web/src/blockkit/values";
import { DemoFailed, DemoGone, demoApi } from "../../web/src/demo/api";
import { deriveScreen } from "../../web/src/demo/model";
import { blockAction, viewSubmission } from "../../web/src/demo/payloads";
import { createApp } from "../src/app";
import { testDeps } from "./helpers";

/** The browser's own client and payload builders, pointed at the real app in-process. */
function setup() {
  const app = createApp(testDeps());
  return demoApi(async (path, init) => app.request(path, init));
}
const none = new Set<number>();

function undoButton(blocks: Block[]): { action_id: string; value?: string } {
  for (const block of blocks) {
    if (block.type !== "actions") continue;
    const el = block.elements[0];
    if (el?.type === "button") return { action_id: el.action_id, value: el.value };
  }
  throw new Error("this card has no button");
}

/** Types /ooo and saves the form as it opens. Returns the screen afterwards. */
async function save(api: ReturnType<typeof setup>, id: string) {
  expect(await api.sendCommand(id, "/ooo")).toEqual({ text: "" });
  const open = deriveScreen(await api.getState(id), none).openView;
  if (!open) throw new Error("no form opened");
  const answer = await api.interact(id, viewSubmission(open.view, initialValues(open.view)));
  expect(answer).toEqual({ response_action: "clear" });
  return deriveScreen(await api.getState(id), none);
}

describe("the web emulator's contract with the demo backend", () => {
  it("drives the whole flow with the browser's own payloads", async () => {
    const api = setup();
    const session = await api.createSession("Europe/Paris");
    expect(session.you).toMatchObject({ slackUserId: "U_DANA", tz: "Europe/Paris" });

    const saved = await save(api, session.id);
    expect(saved.messages).toHaveLength(1);
    const receipt = saved.messages[0];
    if (!receipt) throw new Error("no receipt");
    expect(receipt.text).toMatch(/^Out of office · /);
    expect(saved.statuses.U_DANA).toMatchObject({ text: "Out of office", emoji: ":palm_tree:" });

    expect(await api.interact(session.id, blockAction(undoButton(receipt.blocks), receipt.seq))).toBeNull();
    const undone = deriveScreen(await api.getState(session.id), none);
    expect(undone.messages).toHaveLength(1);
    expect(undone.messages[0]?.seq).toBe(receipt.seq);
    expect(undone.messages[0]?.text).toMatch(/^Undone · /);
    expect(undone.statuses.U_DANA).toBeNull();
  });

  it("returns the form's errors keyed by field", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    await api.sendCommand(id, "/ooo");
    const open = deriveScreen(await api.getState(id), none).openView;
    if (!open) throw new Error("no form opened");
    const answer = await api.interact(
      id,
      viewSubmission(open.view, { ...initialValues(open.view), to: "2000-01-01" }),
    );
    expect(answer).toEqual({
      response_action: "errors",
      errors: { to: "The last day has already passed." },
    });
  });

  it("replaces the card whose button was pressed, not the last message", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    const first = (await save(api, id)).messages[0];
    const afterSecond = await save(api, id);
    const second = afterSecond.messages[1];
    if (!first || !second) throw new Error("expected two receipts");

    await api.interact(id, blockAction(undoButton(first.blocks), first.seq)); // already replaced: a refusal is appended
    await api.interact(id, blockAction(undoButton(second.blocks), second.seq));
    const screen = deriveScreen(await api.getState(id), none);
    expect(screen.messages).toHaveLength(3);
    expect(screen.messages[0]?.text).toMatch(/^Out of office · /);
    expect(screen.messages[1]?.seq).toBe(second.seq);
    expect(screen.messages[1]?.text).toMatch(/^Undone · /);
    expect(screen.messages[2]?.text).toContain("already replaced by a newer one");
  });

  it("shows a status as cleared once the clock passes its expiration", async () => {
    const api = setup();
    const { id } = await api.createSession("Europe/Paris");
    await save(api, id);
    const later = await api.advance(id, 1440);
    expect(deriveScreen(later, none).statuses.U_DANA).toBeNull();
  });

  it("names an expired session and carries the backend's own sentence for a refusal", async () => {
    const api = setup();
    await expect(api.getState("no-such-session")).rejects.toBeInstanceOf(DemoGone);
    const { id } = await api.createSession("Europe/Paris");
    const refusal = await api.sendCommand(id, "hello").catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(DemoFailed);
    expect((refusal as Error).message).toBe("Only /ooo is available in the demo.");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test`
Expected: the three new files fail on missing modules, and the new `demoInteractionPayload` test fails because the URL has no `/3`; everything else passes.

- [ ] **Step 3: Give a button press its own response URL in the backend**

In `apps/worker/src/routes/demo.ts`, replace the `responseUrlFor` helper with:

```ts
const MESSAGE_TS = /^\d{1,10}$/;

/**
 * Where a receipt goes. A button press names the message it lives on (Slack's
 * `container.message_ts`), so a receipt that replaces the original can say which one.
 */
function responseUrlFor(session: Pick<DemoSession, "id">, body?: Record<string, unknown>): string {
  const base = `https://hooks.slack.com/demo/${session.id}`;
  const ts = body && isObject(body.container) ? body.container.message_ts : undefined;
  return typeof ts === "string" && MESSAGE_TS.test(ts) ? `${base}/${ts}` : base;
}
```

and in `demoInteractionPayload` change `const url = responseUrlFor(session);` to `const url = responseUrlFor(session, body);`. The `/command` route keeps calling `responseUrlFor(session)`.

- [ ] **Step 4: Write the three pure modules**

`apps/web/src/demo/api.ts`:

```ts
import type { Block, ModalView } from "@steward/core/blocks";

export type DemoPerson = { slackUserId: string; displayName: string; tz: string };
export type DemoSessionInfo = {
  id: string;
  expiresAt: number;
  clockOffsetMs: number;
  you: DemoPerson | null;
  people: DemoPerson[];
};
export type SlackStatus = { text: string; emoji: string; expiration: number };
export type DemoEvent =
  | { seq: number; kind: "view"; at: number; payload: { triggerId: string; view: ModalView } }
  | {
      seq: number;
      kind: "response";
      at: number;
      payload: { responseUrl: string; text: string; blocks: Block[]; replaceOriginal: boolean };
    }
  | {
      seq: number;
      kind: "status";
      at: number;
      payload: { slackUserId: string; status: SlackStatus | null };
    };
export type DemoState = { now: number; expiresAt: number; clockOffsetMs: number; events: DemoEvent[] };
export type SubmitAnswer =
  | { response_action: "clear" }
  | { response_action: "errors"; errors: Record<string, string> };

/** 404: the session expired or never existed. */
export class DemoGone extends Error {}
/** 429: no session to spare, or this visitor is sending requests too fast. The message is the backend's sentence when it sent one. */
export class DemoBusy extends Error {}
/** Anything else that is not a success. The message is the backend's own sentence when it sent one. */
export class DemoFailed extends Error {}

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;
export type DemoApi = {
  createSession(tz: string): Promise<DemoSessionInfo>;
  getState(id: string): Promise<DemoState>;
  sendCommand(id: string, text: string): Promise<{ text: string }>;
  /** A form submission answers with JSON; a button press answers with nothing (null). */
  interact(id: string, payload: unknown): Promise<SubmitAnswer | null>;
  advance(id: string, minutes: number): Promise<DemoState>;
};

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 404) throw new DemoGone("This demo session has ended.");
  let sentence: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") sentence = body.error;
  } catch {
    // not JSON: fall back to a sentence of our own
  }
  if (res.status === 429) throw new DemoBusy(sentence ?? "The demo is busy right now.");
  throw new DemoFailed(sentence ?? `The demo answered ${res.status}.`);
}

export function demoApi(fetchFn: FetchFn): DemoApi {
  const post = (path: string, body: unknown) =>
    fetchFn(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const json = async <T>(res: Promise<Response>): Promise<T> =>
    (await (await check(await res)).json()) as T;
  const at = (id: string, leaf: string) => `/demo/${encodeURIComponent(id)}/${leaf}`;
  return {
    createSession: (tz) => json<DemoSessionInfo>(post("/demo/sessions", { tz })),
    getState: (id) => json<DemoState>(fetchFn(at(id, "state"))),
    sendCommand: (id, text) => json<{ text: string }>(post(at(id, "command"), { text })),
    interact: async (id, payload) => {
      const res = await check(await post(at(id, "interact"), payload));
      const text = await res.text();
      return text ? (JSON.parse(text) as SubmitAnswer) : null;
    },
    advance: (id, minutes) => json<DemoState>(post(at(id, "advance"), { minutes })),
  };
}
```

`apps/web/src/demo/model.ts`:

```ts
import type { Block, ModalView } from "@steward/core/blocks";
import { emojify } from "../blockkit/emoji";
import type { DemoState, SlackStatus } from "./api";

export type Message = { seq: number; at: number; text: string; blocks: Block[] };
export type Screen = {
  messages: Message[];
  openView: { seq: number; view: ModalView } | null;
  /** Keyed by Slack user id. null means the status was cleared or has expired. */
  statuses: Record<string, SlackStatus | null>;
};

/** A button press's response URL ends with the seq of the message the button lives on. */
const TARGET = /\/(\d{1,10})$/;

/** Everything the screen shows, from what the fake Slack recorded. `closedViews` are forms the visitor dismissed or saved. */
export function deriveScreen(
  state: Pick<DemoState, "now" | "events">,
  closedViews: ReadonlySet<number>,
): Screen {
  const messages: Message[] = [];
  const statuses: Record<string, SlackStatus | null> = {};
  let openView: Screen["openView"] = null;
  for (const event of state.events) {
    if (event.kind === "view") {
      openView = closedViews.has(event.seq) ? null : { seq: event.seq, view: event.payload.view };
    } else if (event.kind === "response") {
      const { text, blocks, replaceOriginal, responseUrl } = event.payload;
      let index = -1;
      if (replaceOriginal) {
        const named = TARGET.exec(responseUrl)?.[1];
        index =
          named === undefined
            ? messages.length - 1
            : messages.findIndex((m) => m.seq === Number(named));
      }
      const original = messages[index];
      // A replaced card keeps its place and its identity, as a Slack message keeps its timestamp.
      if (original) messages[index] = { seq: original.seq, at: original.at, text, blocks };
      else messages.push({ seq: event.seq, at: event.at, text, blocks });
    } else {
      statuses[event.payload.slackUserId] = event.payload.status;
    }
  }
  // Slack clears a status by itself when its expiration passes.
  for (const [user, status] of Object.entries(statuses)) {
    if (status && status.expiration > 0 && status.expiration * 1000 <= state.now) statuses[user] = null;
  }
  return { messages, openView, statuses };
}

/** Something the emulator itself says in the thread (a refusal's sentence, a fresh-session note). */
export type Notice = { id: number; afterSeq: number; text: string };
export type ThreadItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "notice"; key: string; text: string };

/** Messages and notices in the order they appeared. */
export function thread(messages: Message[], notices: Notice[]): ThreadItem[] {
  const rows: { order: number; tie: number; item: ThreadItem }[] = [
    ...messages.map((message) => ({
      order: message.seq,
      tie: 0,
      item: { kind: "message" as const, key: `m${message.seq}`, message },
    })),
    ...notices.map((notice) => ({
      order: notice.afterSeq + 0.5,
      tie: notice.id,
      item: { kind: "notice" as const, key: `n${notice.id}`, text: notice.text },
    })),
  ];
  rows.sort((a, b) => a.order - b.order || a.tie - b.tie);
  return rows.map((row) => row.item);
}

export function formatDay(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(epochMs));
}

export function formatTime(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

/** The side panel's one line for a person's Slack status. The expiration is the midnight after the last day. */
export function statusLine(status: SlackStatus | null | undefined, tz: string): string {
  if (!status) return "No status set";
  const until =
    status.expiration > 0 ? ` · until ${formatDay(status.expiration * 1000 - 1, tz)}` : "";
  return `${emojify(status.emoji)} ${status.text}${until}`;
}
```

`apps/web/src/demo/payloads.ts`:

```ts
import type { ModalView } from "@steward/core/blocks";
import type { Values } from "../blockkit/values";

type ValueNode =
  | { type: "static_select"; selected_option: { value: string } | null }
  | { type: "datepicker"; selected_date: string | null }
  | { type: "plain_text_input"; value: string | null };

/** What Slack sends when a modal is submitted. The backend fills in who, where and the metadata. */
export function viewSubmission(view: ModalView, values: Values) {
  const stateValues: Record<string, Record<string, ValueNode>> = {};
  for (const block of view.blocks) {
    if (block.type !== "input") continue;
    const el = block.element;
    const value = values[block.block_id] ?? "";
    let node: ValueNode | null = null;
    if (el.type === "static_select")
      node = { type: el.type, selected_option: value ? { value } : null };
    else if (el.type === "datepicker") node = { type: el.type, selected_date: value || null };
    else if (el.type === "plain_text_input") node = { type: el.type, value: value || null };
    if (node) stateValues[block.block_id] = { [el.action_id]: node };
  }
  return {
    type: "view_submission" as const,
    view: { type: "modal", callback_id: view.callback_id, state: { values: stateValues } },
  };
}

/** What Slack sends when a button on a message is pressed. `messageSeq` names the message it lives on. */
export function blockAction(action: { action_id: string; value?: string }, messageSeq: number) {
  return {
    type: "block_actions" as const,
    container: { type: "message", message_ts: String(messageSeq) },
    actions: [{ type: "button", action_id: action.action_id, value: action.value }],
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass, including `webContract.test.ts` (five tests against the real app).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0. The Worker's test typecheck now also compiles the three web modules and `blockkit/values.ts`, `blockkit/emoji.ts`; if it reports a browser-only type in them, the module is not pure: fix the module, not the tsconfig.

```bash
git add apps/web/src/demo apps/worker/src/routes/demo.ts apps/worker/test/demo.test.ts apps/worker/test/webContract.test.ts
git commit -m "feat(web): the emulator's client, screen model and payload builders, proven against the real demo backend; a receipt names the message it replaces"
```

---

### Task 7: The emulator

**Files:**
- Create: `apps/web/src/demo/useDemoSession.ts`, `apps/web/src/demo/Emulator.tsx`
- Modify: `apps/web/src/pages/Try.tsx`
- Test: `apps/web/src/demo/Emulator.test.tsx`

**Interfaces:**
- Consumes: `demoApi`, `DemoApi`, `DemoBusy`, `DemoGone`, `DemoSessionInfo`, `DemoState` (`demo/api.ts`); `deriveScreen`, `thread`, `formatDay`, `formatTime`, `statusLine`, `Notice`, `Screen` (`demo/model.ts`); `viewSubmission`, `blockAction` (`demo/payloads.ts`); `Blocks`, `BlockAction` (`blockkit/Blocks.tsx`); `Modal` (`blockkit/Modal.tsx`); `Values`, `initialValues` (`blockkit/values.ts`).
- Produces:
  ```ts
  // useDemoSession.ts
  export type Store = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
  export type Phase = "loading" | "ready" | "busy" | "failed";
  export function useDemoSession(opts: { api: DemoApi; store: Store; tz: string }): {
    phase: Phase;
    failure: string | null;            // the backend's own sentence when it refused to start a session
    info: DemoSessionInfo | null;
    screen: Screen;
    now: number;                       // the session's clock
    notices: Notice[];
    errors: Record<string, string>;    // the open form's errors, keyed by block_id
    working: boolean;                  // a request is in flight
    command(text: string): Promise<void>;
    submit(open: { seq: number; view: ModalView }, values: Values): Promise<void>;
    press(action: BlockAction, messageSeq: number): Promise<void>;
    advance(minutes: number): Promise<void>;
    closeView(seq: number): void;
    restart(): Promise<void>;
  };
  // Emulator.tsx
  export function Emulator(props: { api: DemoApi; store: Store; tz: string }): JSX.Element;
  ```
- Behaviour the tests pin down: the session id and the forms the visitor closed survive a reload through `store` under the key `steward.demo` as `{"info": DemoSessionInfo, "closed": number[]}`; a `DemoGone` on restore or on any action starts a fresh session and says so in the thread with the notice "Your demo hour ended, so this is a fresh one."; a `DemoFailed` shows the error's own message as a notice; `DemoBusy` shows "The demo is busy right now. Try again in a few minutes." with a "Try again" button; a `DemoFailed` while starting shows that error's own message (for example "The demo is switched off.") with the same button.

- [ ] **Step 1: Write the failing test**

`apps/web/src/demo/Emulator.test.tsx`:

```tsx
// @vitest-environment jsdom
import {
  actions,
  button,
  context,
  datepicker,
  header,
  input,
  type ModalView,
  option,
  plain,
  section,
  staticSelect,
  textInput,
} from "@steward/core/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DemoApi,
  DemoBusy,
  type DemoEvent,
  DemoFailed,
  DemoGone,
  type DemoSessionInfo,
  type DemoState,
} from "./api";
import { Emulator } from "./Emulator";
import type { Store } from "./useDemoSession";

afterEach(cleanup);

const START = Date.UTC(2026, 10, 12, 8, 0); // Thu 12 Nov 2026, 08:00 in London
const BASE = "https://hooks.slack.com/demo/s1";
const people = [
  { slackUserId: "U_DANA", displayName: "Dana", tz: "Europe/London" },
  { slackUserId: "U_OMER", displayName: "Omer", tz: "America/New_York" },
  { slackUserId: "U_NOA", displayName: "Noa", tz: "Asia/Jerusalem" },
];
const info: DemoSessionInfo = {
  id: "s1",
  expiresAt: START + 3_600_000,
  clockOffsetMs: 0,
  you: people[0] ?? null,
  people,
};
const form: ModalView = {
  type: "modal",
  callback_id: "ooo_status",
  title: plain("Set your availability"),
  submit: plain("Save"),
  close: plain("Cancel"),
  blocks: [
    input("type", "What's happening?", staticSelect("type", [option("Out of office", "out")], option("Out of office", "out"))),
    input("from", "From", datepicker("from", "2026-11-12")),
    input("to", "To (last day)", datepicker("to", "2026-11-12")),
    input("text", "Status text", textInput("text", "Out of office"), true),
  ],
};
const TITLE = "Out of office · Thu 12 Nov";

/** A scripted stand-in for the backend. The real one is covered by the Worker's webContract test. */
function fakeApi() {
  const events: DemoEvent[] = [];
  let now = START;
  let seq = 0;
  const state = (): DemoState => ({ now, expiresAt: info.expiresAt, clockOffsetMs: 0, events: [...events] });
  const api: DemoApi = {
    createSession: vi.fn<DemoApi["createSession"]>(async () => info),
    getState: vi.fn<DemoApi["getState"]>(async () => state()),
    sendCommand: vi.fn<DemoApi["sendCommand"]>(async (_id, text) => {
      if (!text.startsWith("/ooo")) throw new DemoFailed("Only /ooo is available in the demo.");
      events.push({ seq: ++seq, at: now, kind: "view", payload: { triggerId: `t${seq}`, view: form } });
      return { text: "" };
    }),
    interact: vi.fn<DemoApi["interact"]>(async (_id, payload) => {
      const sent = payload as {
        type: string;
        container?: { message_ts: string };
        view?: { state: { values: Record<string, Record<string, { selected_date?: string | null }>> } };
      };
      if (sent.type === "view_submission") {
        if (sent.view?.state.values.to?.to?.selected_date === "2000-01-01")
          return { response_action: "errors", errors: { to: "The last day has already passed." } };
        const status = { text: "Out of office", emoji: ":palm_tree:", expiration: Date.UTC(2026, 10, 13) / 1000 };
        events.push({ seq: ++seq, at: now, kind: "status", payload: { slackUserId: "U_DANA", status } });
        const blocks = [
          header(TITLE),
          section("✅ Slack status set — clears Thu 12 Nov"),
          actions(button("Undo", "status_undo", { value: "st_1", style: "danger" })),
          context("You can undo until 08:05."),
        ];
        events.push({
          seq: ++seq,
          at: now,
          kind: "response",
          payload: { responseUrl: BASE, text: TITLE, blocks, replaceOriginal: false },
        });
        return { response_action: "clear" };
      }
      events.push({ seq: ++seq, at: now, kind: "status", payload: { slackUserId: "U_DANA", status: null } });
      events.push({
        seq: ++seq,
        at: now,
        kind: "response",
        payload: {
          responseUrl: `${BASE}/${sent.container?.message_ts ?? ""}`,
          text: `Undone · ${TITLE}`,
          blocks: [header(`Undone · ${TITLE}`), section("↩️ Slack status cleared")],
          replaceOriginal: true,
        },
      });
      return null;
    }),
    advance: vi.fn<DemoApi["advance"]>(async (_id, minutes) => {
      now += minutes * 60_000;
      return state();
    }),
  };
  return api;
}

function memoryStore(seed?: string): Store {
  const map = new Map<string, string>(seed ? [["steward.demo", seed]] : []);
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

async function open(api: DemoApi, store: Store = memoryStore()) {
  render(<Emulator api={api} store={store} tz="Europe/London" />);
  return screen.findByRole("textbox", { name: "Message Steward" });
}
function send(box: HTMLElement, text: string) {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("Emulator", () => {
  it("runs /ooo from the composer to a receipt, then undoes it on the card it came from", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog", { name: "Set your availability" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: TITLE });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("🌴 Out of office · until Thu 12 Nov")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("heading", { name: `Undone · ${TITLE}` });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getAllByText("No status set")).toHaveLength(3);
    // view = 1, status = 2, receipt = 3: the press names message 3.
    expect(api.interact).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({ type: "block_actions", container: { type: "message", message_ts: "3" } }),
    );
  });

  it("keeps the form open and shows the backend's error under its field", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("To (last day)"), { target: { value: "2000-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The last day has already passed.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the form on Cancel and does not reopen it", async () => {
    const api = fakeApi();
    send(await open(api), "/ooo");
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the backend's own sentence when a command is refused", async () => {
    const api = fakeApi();
    send(await open(api), "hello");
    expect(await screen.findByText(/Only \/ooo is available in the demo\./)).toBeTruthy();
  });

  it("moves the clock forward", async () => {
    const api = fakeApi();
    await open(api);
    expect(screen.getByText("Thu 12 Nov, 08:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+1 day" }));
    expect(await screen.findByText("Fri 13 Nov, 08:00")).toBeTruthy();
    expect(api.advance).toHaveBeenCalledWith("s1", 1440);
  });

  it("picks a saved session up again after a reload", async () => {
    const api = fakeApi();
    await open(api, memoryStore(JSON.stringify({ info, closed: [] })));
    expect(api.getState).toHaveBeenCalledWith("s1");
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("starts a fresh session, and says so, when the saved one has expired", async () => {
    const api = fakeApi();
    const fresh = api.getState;
    api.getState = vi
      .fn<DemoApi["getState"]>()
      .mockRejectedValueOnce(new DemoGone("gone"))
      .mockImplementation(fresh);
    await open(api, memoryStore(JSON.stringify({ info: { ...info, id: "old" }, closed: [] })));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Your demo hour ended, so this is a fresh one\./)).toBeTruthy();
  });

  it("says so when the demo is busy, and can try again", async () => {
    const api = fakeApi();
    api.createSession = vi
      .fn<DemoApi["createSession"]>()
      .mockRejectedValueOnce(new DemoBusy("busy"))
      .mockResolvedValue(info);
    render(<Emulator api={api} store={memoryStore()} tz="Europe/London" />);
    expect(await screen.findByText("The demo is busy right now. Try again in a few minutes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Message Steward" })).toBeTruthy();
  });

  it("says the backend's own sentence when the demo cannot start", async () => {
    const api = fakeApi();
    api.createSession = vi
      .fn<DemoApi["createSession"]>()
      .mockRejectedValue(new DemoFailed("The demo is switched off."));
    render(<Emulator api={api} store={memoryStore()} tz="Europe/London" />);
    expect(await screen.findByText("The demo is switched off.")).toBeTruthy();
  });

  it("carries the note that it is not Slack", async () => {
    await open(fakeApi());
    expect(screen.getByText("Slack-inspired styling. Steward is not affiliated with Slack.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm test`
Expected: `Emulator.test.tsx` fails on the missing `./Emulator` and `./useDemoSession` modules; everything else passes.

- [ ] **Step 3: Write the hook that owns a session**

`apps/web/src/demo/useDemoSession.ts`:

```ts
import type { ModalView } from "@steward/core/blocks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockAction } from "../blockkit/Blocks";
import type { Values } from "../blockkit/values";
import {
  type DemoApi,
  DemoBusy,
  DemoFailed,
  DemoGone,
  type DemoSessionInfo,
  type DemoState,
} from "./api";
import { deriveScreen, type Notice, type Screen } from "./model";
import { blockAction, viewSubmission } from "./payloads";

/** Where the session id survives a reload. The page passes sessionStorage; tests pass a Map. */
export type Store = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};
export type Phase = "loading" | "ready" | "busy" | "failed";

const KEY = "steward.demo";
const FRESH = "Your demo hour ended, so this is a fresh one.";
const NO_ANSWER = "The demo didn't answer. Check your connection and try again.";
const EMPTY: Screen = { messages: [], openView: null, statuses: {} };

type Saved = { info: DemoSessionInfo; closed: number[] };

function readSaved(store: Store): Saved | null {
  try {
    const saved = JSON.parse(store.get(KEY) ?? "null") as Partial<Saved> | null;
    if (saved?.info && typeof saved.info.id === "string" && Array.isArray(saved.closed))
      return { info: saved.info, closed: saved.closed.filter((n) => typeof n === "number") };
  } catch {
    // unreadable: start a new session
  }
  return null;
}

export function useDemoSession(opts: { api: DemoApi; store: Store; tz: string }) {
  const { api, store, tz } = opts;
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [info, setInfo] = useState<DemoSessionInfo | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());
  const [notices, setNotices] = useState<Notice[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const started = useRef(false);
  const lastSeq = useRef(0);
  const noticeId = useRef(0);

  const show = useCallback((next: DemoState) => {
    lastSeq.current = next.events.at(-1)?.seq ?? 0;
    setState(next);
  }, []);

  const notify = useCallback((text: string) => {
    noticeId.current += 1;
    const notice: Notice = { id: noticeId.current, afterSeq: lastSeq.current, text };
    setNotices((all) => [...all, notice]);
  }, []);

  const begin = useCallback(
    async (note?: string) => {
      setPhase("loading");
      try {
        const fresh = await api.createSession(tz);
        const first = await api.getState(fresh.id);
        setInfo(fresh);
        setClosed(new Set());
        setErrors({});
        setNotices([]);
        show(first);
        if (note) notify(note);
        setPhase("ready");
      } catch (err) {
        // A refusal carries the backend's own sentence (for example when the demo is switched off).
        setFailure(err instanceof DemoFailed ? err.message : null);
        setPhase(err instanceof DemoBusy ? "busy" : "failed");
      }
    },
    [api, tz, show, notify],
  );

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;
    void (async () => {
      const saved = readSaved(store);
      if (!saved) return begin();
      try {
        const current = await api.getState(saved.info.id);
        setInfo(saved.info);
        setClosed(new Set(saved.closed));
        show(current);
        setPhase("ready");
      } catch (err) {
        if (!(err instanceof DemoGone)) return setPhase("failed");
        store.remove(KEY);
        await begin(FRESH);
      }
    })();
  }, [api, store, begin, show]);

  useEffect(() => {
    if (info) store.set(KEY, JSON.stringify({ info, closed: [...closed] }));
  }, [info, closed, store]);

  /** Runs one request at a time, then shows the state it left behind. */
  const run = useCallback(
    async (work: (id: string) => Promise<DemoState | undefined>) => {
      if (!info || working) return;
      setWorking(true);
      try {
        show((await work(info.id)) ?? (await api.getState(info.id)));
      } catch (err) {
        if (err instanceof DemoGone) {
          store.remove(KEY);
          await begin(FRESH);
        } else {
          // A refusal (a cap reached, too many requests) carries the backend's own sentence.
          const refused = err instanceof DemoFailed || err instanceof DemoBusy;
          notify(refused ? err.message : NO_ANSWER);
        }
      } finally {
        setWorking(false);
      }
    },
    [api, store, info, working, begin, show, notify],
  );

  const closeView = useCallback((seq: number) => {
    setClosed((all) => new Set([...all, seq]));
    setErrors({});
  }, []);

  const command = useCallback(
    (text: string) =>
      run(async (id) => {
        setErrors({});
        const answer = await api.sendCommand(id, text);
        if (answer.text) notify(answer.text); // the product's own immediate reply, shown as it is
        return undefined;
      }),
    [api, run, notify],
  );

  const submit = useCallback(
    (open: { seq: number; view: ModalView }, values: Values) =>
      run(async (id) => {
        const answer = await api.interact(id, viewSubmission(open.view, values));
        if (answer?.response_action === "errors") setErrors(answer.errors);
        else closeView(open.seq);
        return undefined;
      }),
    [api, run, closeView],
  );

  const press = useCallback(
    (action: BlockAction, messageSeq: number) =>
      run(async (id) => {
        await api.interact(id, blockAction(action, messageSeq));
        return undefined;
      }),
    [api, run],
  );

  const advance = useCallback(
    (minutes: number) => run((id) => api.advance(id, minutes)),
    [api, run],
  );

  const restart = useCallback(async () => {
    store.remove(KEY);
    await begin();
  }, [store, begin]);

  const screen = useMemo(() => (state ? deriveScreen(state, closed) : EMPTY), [state, closed]);

  return {
    phase,
    failure,
    info,
    screen,
    now: state?.now ?? 0,
    notices,
    errors,
    working,
    command,
    submit,
    press,
    advance,
    closeView,
    restart,
  };
}
```

- [ ] **Step 4: Write the workspace and mount it at /try**

`apps/web/src/demo/Emulator.tsx`:

```tsx
import type { ModalView } from "@steward/core/blocks";
import { type FormEvent, type ReactNode, useState } from "react";
import { Blocks } from "../blockkit/Blocks";
import { Modal } from "../blockkit/Modal";
import { initialValues, type Values } from "../blockkit/values";
import type { DemoApi } from "./api";
import { formatDay, formatTime, statusLine, thread } from "./model";
import { type Store, useDemoSession } from "./useDemoSession";

const PANEL_BUTTON =
  "rounded border border-neutral-400 px-2 py-1 text-sm font-bold disabled:opacity-50";
const PANEL_HEADING = "text-xs font-bold uppercase tracking-wide text-neutral-500";
const RULE = "border-neutral-200 dark:border-neutral-700";
const STEPS = [
  { label: "+5 min", minutes: 5 },
  { label: "+1 hour", minutes: 60 },
  { label: "+1 day", minutes: 1440 },
] as const;

/** The open form. Keyed by the view's seq, so a new form starts from its own initial values. */
function OpenForm(props: {
  open: { seq: number; view: ModalView };
  errors: Record<string, string>;
  busy: boolean;
  onSubmit: (values: Values) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(props.open.view));
  return (
    <Modal
      view={props.open.view}
      values={values}
      errors={props.errors}
      busy={props.busy}
      onChange={(blockId, value) => setValues((all) => ({ ...all, [blockId]: value }))}
      onSubmit={() => props.onSubmit(values)}
      onClose={props.onClose}
    />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center bg-white p-6 text-center text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {children}
    </main>
  );
}

export function Emulator(props: { api: DemoApi; store: Store; tz: string }) {
  const demo = useDemoSession(props);
  const [draft, setDraft] = useState("");

  if (demo.phase === "loading")
    return (
      <Centered>
        <p role="status">Starting your demo…</p>
      </Centered>
    );
  if (demo.phase !== "ready" || !demo.info)
    return (
      <Centered>
        <p role="alert">
          {demo.phase === "busy"
            ? "The demo is busy right now. Try again in a few minutes."
            : (demo.failure ?? "The demo couldn't start. Check your connection and try again.")}
        </p>
        <button type="button" className={`${PANEL_BUTTON} mt-4`} onClick={() => void demo.restart()}>
          Try again
        </button>
      </Centered>
    );

  const { info } = demo;
  const tz = info.you?.tz ?? props.tz;
  const items = thread(demo.screen.messages, demo.notices);
  const open = demo.screen.openView;

  const onSend = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void demo.command(text);
  };

  return (
    <div className="flex h-dvh flex-col bg-white text-neutral-900 md:flex-row dark:bg-neutral-900 dark:text-neutral-100">
      <nav aria-label="Workspace" className="hidden w-56 shrink-0 bg-slate-900 p-4 text-slate-300 md:block">
        <p className="text-lg font-extrabold text-white">Acme</p>
        <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Channels</p>
        <p className="mt-1 px-2"># general</p>
        <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Direct messages</p>
        <p className="mt-1 rounded bg-slate-700 px-2 py-1 font-bold text-white">Steward</p>
        {info.people.map((person) => (
          <p key={person.slackUserId} className="mt-1 px-2">
            {person.slackUserId === info.you?.slackUserId
              ? `${person.displayName} (you)`
              : person.displayName}
          </p>
        ))}
      </nav>

      <main className="flex min-h-0 flex-1 flex-col">
        <header className={`border-b px-4 py-3 ${RULE}`}>
          <h1 className="font-extrabold">Steward</h1>
        </header>
        <ol aria-label="Messages" aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {items.length === 0 ? (
            <li className="text-neutral-500">
              This is your direct message with Steward. Type /ooo to tell it you are away.
            </li>
          ) : null}
          {items.map((item) =>
            item.kind === "notice" ? (
              <li key={item.key} className="text-sm text-neutral-500">
                <span className="italic">Only visible to you · </span>
                <span>{item.text}</span>
              </li>
            ) : (
              <li key={item.key} className="flex gap-3">
                <div aria-hidden="true" className="h-9 w-9 shrink-0 rounded bg-emerald-700" />
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-bold">Steward </span>
                    <span className="text-xs text-neutral-500">
                      {`${formatTime(item.message.at, tz)} · Only visible to you`}
                    </span>
                  </p>
                  {item.message.blocks.length > 0 ? (
                    <Blocks
                      blocks={item.message.blocks}
                      disabled={demo.working}
                      onAction={(action) => void demo.press(action, item.message.seq)}
                    />
                  ) : (
                    <p>{item.message.text}</p>
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
        <form onSubmit={onSend} className={`flex gap-2 border-t p-3 ${RULE}`}>
          <input
            aria-label="Message Steward"
            className="min-w-0 flex-1 rounded border border-neutral-400 bg-white px-3 py-2 dark:bg-neutral-800"
            placeholder="Type /ooo and press Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            disabled={demo.working}
            className="rounded bg-emerald-700 px-4 py-2 font-bold text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </main>

      <aside
        aria-label="Behind the scenes"
        className={`max-h-[40dvh] w-full shrink-0 space-y-5 overflow-y-auto border-t p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l ${RULE}`}
      >
        <div>
          <h2 className="font-extrabold">Behind the scenes</h2>
          <p className="text-sm text-neutral-500">What Steward has written to this pretend Slack.</p>
        </div>
        <section>
          <h3 className={PANEL_HEADING}>Slack status</h3>
          <ul className="mt-1 space-y-2">
            {info.people.map((person) => (
              <li key={person.slackUserId}>
                <p className="font-bold">{person.displayName}</p>
                <p>{statusLine(demo.screen.statuses[person.slackUserId], person.tz)}</p>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3 className={PANEL_HEADING}>Clock</h3>
          <p className="mt-1">{`${formatDay(demo.now, tz)}, ${formatTime(demo.now, tz)}`}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {STEPS.map((step) => (
              <button
                key={step.label}
                type="button"
                className={PANEL_BUTTON}
                disabled={demo.working}
                onClick={() => void demo.advance(step.minutes)}
              >
                {step.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-neutral-500">
            Move time forward to watch the undo window close and the status expire.
          </p>
        </section>
        <section>
          <h3 className={PANEL_HEADING}>Session</h3>
          <p className="mt-1 text-sm">{`This demo resets at ${formatTime(info.expiresAt, tz)}.`}</p>
          <button type="button" className={`${PANEL_BUTTON} mt-2`} onClick={() => void demo.restart()}>
            Start over
          </button>
        </section>
        <p className="text-xs text-neutral-500">
          Slack-inspired styling. Steward is not affiliated with Slack.
        </p>
      </aside>

      {open ? (
        <OpenForm
          key={open.seq}
          open={open}
          errors={demo.errors}
          busy={demo.working}
          onSubmit={(values) => void demo.submit(open, values)}
          onClose={() => demo.closeView(open.seq)}
        />
      ) : null}
    </div>
  );
}
```

`apps/web/src/pages/Try.tsx` becomes:

```tsx
import { demoApi } from "../demo/api";
import { Emulator } from "../demo/Emulator";
import type { Store } from "../demo/useDemoSession";

/** sessionStorage, tolerant of browsers that refuse it: the session then just does not survive a reload. */
const browserStore: Store = {
  get: (key) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // storage refused: nothing to do
    }
  },
  remove: (key) => {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // storage refused: nothing to do
    }
  },
};

const api = demoApi((path, init) => fetch(path, init));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Try() {
  return <Emulator api={api} store={browserStore} tz={tz} />;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass, including the ten `Emulator.test.tsx` tests.

- [ ] **Step 6: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all exit 0. If Biome's `useExhaustiveDependencies` asks for a dependency that is listed above as deliberately absent (there is none by design), do not silence it: report it.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/demo/useDemoSession.ts apps/web/src/demo/Emulator.tsx apps/web/src/demo/Emulator.test.tsx apps/web/src/pages/Try.tsx
git commit -m "feat(web): the emulator at /try: type /ooo, save the real form, read the real receipt, undo it, move the clock"
```

---

### Task 8: The product page

**Files:**
- Modify: `apps/web/src/pages/Product.tsx`, `apps/web/src/pages/Product.test.tsx`, `apps/web/src/main.tsx`, `apps/worker/src/app.ts`, `apps/worker/test/ooo.test.ts`, `README.md`

**Interfaces:**
- Consumes: `pageFor` (`route.ts`), `Try` (`pages/Try.tsx`).
- Produces:
  ```ts
  // apps/worker: GET /health answers { ok: true, slack: boolean }; `slack` is true only when
  // every secret the install flow needs is present.
  // apps/web/src/pages/Product.tsx
  export const REPO_URL = "https://github.com/naftaliurison/steward";
  export function Product(props: { installable: boolean }): JSX.Element;                       // the page itself, no I/O
  export function ProductPage(props: { health: () => Promise<{ slack?: boolean }> }): JSX.Element; // asks /health once
  ```
- Copy rules for this page: every claim under "What works today" must be true of the code on `main`; planned work appears only under "Coming next". Do not add features, numbers, customer names or testimonials.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/ooo.test.ts`, the existing `answers health` test expects the old body: change its expected body to `{ ok: true, slack: true }`, and add next to it:

```ts
it("says Slack install is not configured when a secret is missing", async () => {
  const bare = createApp(testDeps({ slackClientId: "" }));
  expect(await (await bare.request("/health")).json()).toEqual({ ok: true, slack: false });
});
```

Replace `apps/web/src/pages/Product.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Product, ProductPage, REPO_URL } from "./Product";

afterEach(cleanup);

describe("Product page", () => {
  it("names the product, links to the demo and the code, and says it is not Slack", () => {
    render(<Product installable={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Steward Availability");
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe("/try");
    expect(screen.getByRole("link", { name: "Read the code" }).getAttribute("href")).toBe(REPO_URL);
    expect(screen.getByText(/Steward is not affiliated with Slack\./)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What works today" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Coming next" })).toBeTruthy();
  });

  it("offers Add to Slack only when the install flow is configured", () => {
    render(<Product installable={false} />);
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
    cleanup();
    render(<Product installable />);
    expect(screen.getByRole("link", { name: "Add to Slack" }).getAttribute("href")).toBe(
      "/oauth/slack/install",
    );
  });
});

describe("ProductPage", () => {
  it("shows Add to Slack once /health says install is configured", async () => {
    render(<ProductPage health={async () => ({ slack: true })} />);
    expect(await screen.findByRole("link", { name: "Add to Slack" })).toBeTruthy();
  });

  it("stays without it when /health cannot be read", async () => {
    render(<ProductPage health={() => Promise.reject(new Error("offline"))} />);
    expect(await screen.findByRole("link", { name: "Try the demo" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test`
Expected: the two health tests fail on the body; `Product.test.tsx` fails on the missing exports and the new heading.

- [ ] **Step 3: Make /health say whether install is configured**

In `apps/worker/src/app.ts` replace the health route with:

```ts
// `slack` tells the product page whether to offer "Add to Slack": every secret the install flow needs is present.
app.get("/health", (c) =>
  c.json({
    ok: true,
    slack: Boolean(
      deps.slackClientId &&
        deps.slackClientSecret &&
        deps.signingSecret &&
        deps.tokenKey &&
        deps.appUrl,
    ),
  }),
);
```

- [ ] **Step 4: Write the page**

`apps/web/src/pages/Product.tsx`:

```tsx
import { useEffect, useState } from "react";

export const REPO_URL = "https://github.com/naftaliurison/steward";
const DESIGN_URL = `${REPO_URL}/blob/main/docs/superpowers/specs/2026-11-08-steward-availability-design.md`;

const PRIMARY = "rounded bg-emerald-700 px-4 py-2 font-bold text-white";
const SECONDARY = "rounded border border-neutral-400 px-4 py-2 font-bold";
const SECTION_HEADING = "text-xl font-extrabold";

const WORKS_TODAY = [
  "Type /ooo in Slack and a short form opens: what is happening, from when, until when.",
  "Save sets your Slack status until your last day ends, in your own time zone.",
  "A receipt lists each change Steward made, with an Undo button that works for five minutes.",
  "Nothing is written until you press Save, and every write is recorded.",
];
const COMING_NEXT = [
  "Google Calendar out-of-office and the Gmail auto-reply, set and undone together with the status.",
  "Dates in the future, and requests in plain words.",
  "A team view of who is away.",
  "Finding a time for a group and booking it with an agenda.",
];

export function Product({ installable }: { installable: boolean }) {
  return (
    <div className="min-h-dvh bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <main className="mx-auto max-w-2xl space-y-12 px-4 py-16">
        <section>
          <p className="font-bold text-emerald-700">Steward</p>
          <h1 className="mt-1 text-4xl font-extrabold">Steward Availability</h1>
          <p className="mt-4 text-lg">
            Say once that you are out, sick, remote or travelling. Steward sets your Slack status,
            shows you a receipt of what it changed, and lets you undo it.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a className={PRIMARY} href="/try">
              Try the demo
            </a>
            {installable ? (
              <a className={SECONDARY} href="/oauth/slack/install">
                Add to Slack
              </a>
            ) : null}
            <a className={SECONDARY} href={REPO_URL}>
              Read the code
            </a>
          </div>
          <p className="mt-3 text-sm text-neutral-500">
            The demo runs in your browser against a pretend Slack. No sign-up, and nothing you do
            there leaves it.
          </p>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>What works today</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            {WORKS_TODAY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>Coming next</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            {COMING_NEXT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className={SECTION_HEADING}>How it is built</h2>
          <p className="mt-3">
            One TypeScript codebase on Cloudflare Workers with a D1 database. Every write goes
            through one engine that records what it did and knows how to reverse it. The demo on
            this site runs that same code against a pretend Slack.
          </p>
          <p className="mt-3">
            <a className="underline" href={DESIGN_URL}>
              Read the design
            </a>
          </p>
        </section>
      </main>
      <footer className="mx-auto max-w-2xl space-y-1 px-4 pb-10 text-sm text-neutral-500">
        <p>Source available under the Business Source License 1.1.</p>
        <p>The demo uses Slack-inspired styling. Steward is not affiliated with Slack.</p>
      </footer>
    </div>
  );
}

/** The page as served: asks the Worker once whether the Slack install flow is configured. */
export function ProductPage({ health }: { health: () => Promise<{ slack?: boolean }> }) {
  const [installable, setInstallable] = useState(false);
  useEffect(() => {
    let live = true;
    health()
      .then((body) => {
        if (live) setInstallable(body.slack === true);
      })
      .catch(() => {
        // /health unreachable: keep the page without "Add to Slack"
      });
    return () => {
      live = false;
    };
  }, [health]);
  return <Product installable={installable} />;
}
```

`apps/web/src/main.tsx` becomes:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ProductPage } from "./pages/Product";
import { Try } from "./pages/Try";
import { pageFor } from "./route";

const health = async () => (await (await fetch("/health")).json()) as { slack?: boolean };

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    {pageFor(window.location.pathname) === "try" ? <Try /> : <ProductPage health={health} />}
  </StrictMode>,
);
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 6: Bring the README in line**

In `README.md`:
- Replace the "Status:" paragraph with: "Status: `/ooo` form → Slack status → receipt → Undo works end to end, and the same flow runs as a browser demo at `/try` against a pretend Slack. Deployable once the owner's accounts exist; see Deploy below. The design is in [`docs/superpowers/specs/2026-11-08-steward-availability-design.md`](docs/superpowers/specs/2026-11-08-steward-availability-design.md); plans live in `docs/superpowers/plans/`."
- In "Deploy (first time)" step 5, replace the sentence about `DEMO_ENABLED` with: "Set `DEMO_ENABLED` to `1` (`pnpm exec wrangler secret put DEMO_ENABLED`) to switch the public demo at `/try` on; without it `/demo/*` answers 503."
- At the end of "Deploy (first time)" add a short "If something goes wrong" list with these three lines, learned on the first real install: "In Windows PowerShell, call `pnpm.cmd` instead of `pnpm` if scripts are blocked." "If `wrangler login` opens the wrong browser, run `wrangler login --browser=false` and paste the link into the browser where you are signed in to Cloudflare." "Slack's create-app page shows a bot token, a user token and an app token: Steward needs none of them, only the three values under Basic Information → App Credentials."
- In "Deploy (first time)" step 3, the command becomes `pnpm --filter @steward/web build && pnpm --filter @steward/worker release`, and the step ends with: "The product page is at `/`. Set `TOKEN_KEY` now (step 5 shows how) and the demo at `/try` works from this point, before any Slack app exists. `/health` answers `{"ok":true,"slack":false}` until the Slack secrets are set."

- [ ] **Step 7: Typecheck, lint, build, commit**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all exit 0.

```bash
git add apps/web/src/pages/Product.tsx apps/web/src/pages/Product.test.tsx apps/web/src/main.tsx apps/worker/src/app.ts apps/worker/test/ooo.test.ts README.md
git commit -m "feat(web): the product page: what works today, what comes next, how it is built; Add to Slack only when install is configured"
```

---

## After the last task (the controller, not an implementer)

1. Whole-branch review on the most capable model, as in earlier plans, with attention to: the import rule for `apps/web`; that the emulator never states a product sentence the backend did not send; the accessibility floor; the bundle (`apps/web/dist`) containing no server code.
2. Run it for real: `pnpm --filter @steward/worker db:migrate:local`, `pnpm build`, then start `wrangler dev` and, in a browser, open `/` and `/try`; type `/ooo`, save, undo, save again, press "+5 min", press Undo (the refusal sentence appears), press "+1 day" (the status shows as cleared). Check `/health`, `/demo/sessions` (POST) and a deep link such as `/try/` all behave. Repeat at 375 px wide and in dark mode.
3. Record deviations in this document, open the pull request, and ask the owner for the merge word.
