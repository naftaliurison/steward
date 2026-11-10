# Plan 3a: Scheduling and the Tick — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A status whose first day is in the future is saved as scheduled, starts by itself when that day begins in the person's time zone, can be cancelled until then, and a write that fails is tried again with backoff until Steward gives up and says so.

**Architecture:** The minute tick (`apps/worker/src/tick.ts`) gains four bounded steps: end scheduled statuses whose days have all passed, end active statuses whose last day is over, start due scheduled statuses (at most 3 a minute), and retry failed or stranded writes (at most 2 a minute). The engine in `packages/core` learns guarded result recording, a retry time per target and a retry entry point. The demo runs the same steps for one session when the visitor moves its clock.

**Tech Stack:** TypeScript, pnpm workspace, Drizzle ORM on Cloudflare D1 (better-sqlite3 in tests, Miniflare for the D1 smoke tests), Hono on Cloudflare Workers, React 19 + Vite for the emulator, Vitest 3, Biome 2.

## Global Constraints

- Free tiers only. D1 Free allows **50 queries per Worker invocation**; Workers Free allows **50 subrequests per invocation**. The tick's worst case in this plan is 44 queries and 7 subrequests. Any change that adds a statement to the tick must keep the total at 45 or lower.
- No new accounts, no new secrets, no new Slack scopes. The bot already has `chat:write`, which is all `chat.postMessage` needs. Nobody has to reinstall the app.
- **Never run a remote Wrangler command** (`wrangler deploy`, `wrangler d1 ... --remote`, `wrangler secret ...`). The app is live. Local tests only. The owner's session applies the migration and deploys after the PR is merged.
- No employer code, names, people or vocabulary anywhere in this repository.
- All text a person reads is plain words: no jargon, no blame, says what happened and what to do next.
- Every outbound HTTP call goes through the injected `fetchFn` or `SlackClient`. Never call the bare global `fetch` as a method of another object (it throws on Workers).
- The global tick must never start, end or retry anything in a workspace whose id starts with `demo:`. Demo sessions run their own tick on their own clock.
- Run from the repository root (`C:\Users\nafta\steward`). In PowerShell the command is `pnpm.cmd`; in Bash it is `pnpm`.
- Before every commit: `pnpm test`, `pnpm typecheck` and `pnpm lint` all pass.
- Commit messages end with the line `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Work on the branch `plan/3a-scheduling`. Do not merge and do not push to `main`.

## What changes for a person

| Before | After |
|---|---|
| A first day in the future is refused. | It is saved. The receipt is titled "Scheduled · …" and has a **Cancel** button that works until the status starts. |
| The receipt is the only place to cancel, and only the person who got it can see it. | Typing `/ooo` also lists the person's scheduled statuses, each with **Cancel**. |
| A write that fails stays failed. | It is tried again after 1, 2, 4, 8 and 16 minutes. After the sixth failure Steward sends the person one direct message and stops. |
| A status that passes its last day stays "active" in the database for ever. | The tick marks it ended. |

## Decisions already made (do not reopen)

- **Cancel window for a scheduled status:** until it starts. `undoUntilMs` is set to `startMs`. Nothing has been written to Slack before that moment, so cancelling writes nothing.
- **Overlap:** a person may have several scheduled statuses. When one starts while another is active, the active one is ended and recorded as replaced. It is not restored when the newer one ends.
- **A start is quiet.** No message is sent when a scheduled status starts and its write succeeds. A message is sent only when the write was skipped (Slack is not connected for the person) or when Steward gives up after six tries.
- **Bursts drain slowly on purpose.** If more than 3 statuses are due in the same minute, the rest start in the following minutes, oldest first.
- **A first day in the past is still accepted** when the last day has not passed (unchanged).
- **A first day may be at most 365 days ahead.**

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/db/schema.ts` | `status_targets.next_attempt_at`, two indexes | 1 |
| `packages/core/drizzle/0006_*.sql` | generated migration | 1 |
| `packages/core/src/engine/engine.ts` | guarded recording, backoff, `retryTargets`, ordering | 1 |
| `packages/core/src/slack/client.ts`, `fake.ts` | `postMessage` | 2 |
| `apps/worker/src/demo/slackClient.ts` | `postMessage` recorded as a `message` event | 2 |
| `apps/web/src/demo/api.ts`, `model.ts` | the emulator shows `message` events | 2 |
| `packages/availability/src/status/form.ts` | accept future first days | 3 |
| `packages/availability/src/status/service.ts` | cancel window, recovery time, `scheduledStatusesFor` | 3 |
| `packages/availability/src/status/card.ts` | Scheduled / Cancelled wording | 3 |
| `apps/worker/src/tick.ts` | the four tick steps | 4 |
| `apps/worker/src/slack/handlers.ts` | `/ooo` lists scheduled statuses | 5 |
| `apps/worker/src/routes/demo.ts` | moving the demo clock runs that session's tick | 5 |
| `apps/web/src/demo/Emulator.tsx`, `apps/web/src/pages/Product.tsx`, `README.md` | words that stay true | 6 |

---

### Task 1: The engine can retry

**Files:**
- Modify: `packages/core/src/db/schema.ts` (the `statuses` and `statusTargets` tables)
- Create: `packages/core/drizzle/0006_<generated name>.sql` (generated, never hand-written)
- Modify: `packages/core/src/engine/engine.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/availability/src/status/card.test.ts` (the `target()` fixture only)
- Test: `packages/core/src/engine/engine.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (exported from `@steward/core`):
  - `MAX_ATTEMPTS: 6`
  - `nextAttemptAfter(attempts: number, at: number): number | null`
  - `createTargets(db: Db, statusId: string, specs: WriteSpec[], recoverAt?: number | null): Promise<TargetRow[]>`
  - `executeTargets(db, registry, ctx, targets, now): Promise<TargetRow[]>` (unchanged signature; rows now come back in the order given)
  - `retryTargets(db: Db, registry: ConnectorRegistry, ctx: ActorCtx, targets: TargetRow[], now: () => number): Promise<TargetRow[]>`
  - `TargetRow` gains `nextAttemptAt: number | null`

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull --ff-only
git checkout -b plan/3a-scheduling
```

(If the branch already exists because the plan document was committed on it, run `git checkout plan/3a-scheduling` instead.)

- [ ] **Step 2: Write the failing tests**

In `packages/core/src/engine/engine.test.ts`, change the engine import line to:

```ts
import {
  createTargets,
  executeTargets,
  MAX_ATTEMPTS,
  nextAttemptAfter,
  retryTargets,
  targetsForStatus,
  undoTargets,
} from "./engine";
```

Add `statusTargets` to the schema import (`import { audit, statuses, statusTargets } from "../db/schema";`) and, if the file does not import it yet, add `import { eq } from "drizzle-orm";`. Below the `RecordingConnector` class add:

```ts
/** Fails its first `failures` calls, then succeeds. */
class FlakyConnector implements Connector {
  calls = 0;
  constructor(
    readonly system: string,
    private readonly failures: number,
  ) {}
  async perform(): Promise<{ externalId: string }> {
    this.calls++;
    if (this.calls <= this.failures) throw new Error("try later");
    return { externalId: `ext-${this.calls}` };
  }
  async undo(): Promise<void> {}
}
```

Inside `describe("engine", …)` add these tests at the end:

```ts
  it("waits 1, 2, 4, 8 and 16 minutes between tries and gives up after the sixth", () => {
    expect(MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5].map((n) => nextAttemptAfter(n, 0))).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(nextAttemptAfter(6, 0)).toBeNull();
    expect(nextAttemptAfter(1, 1_000)).toBe(61_000);
  });

  it("stores when a stranded target should be picked up, and clears it once the write is done", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a"));
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }], 5_000);
    expect(created[0]?.nextAttemptAt).toBe(5_000);
    const [done] = await executeTargets(db, registry, ctx, created, now);
    expect(done?.state).toBe("done");
    expect(done?.nextAttemptAt).toBeNull();
  });

  it("a failed write says when it will be tried again", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a", "fail"));
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const [failed] = await executeTargets(db, registry, ctx, created, now);
    expect(failed).toMatchObject({ state: "failed", attempts: 1, nextAttemptAt: now() + 60_000 });
  });

  it("retries a failed write until it goes through", async () => {
    const flaky = new FlakyConnector("a", 2);
    const registry = new ConnectorRegistry().register(flaky);
    let rows = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    rows = await executeTargets(db, registry, ctx, rows, now);
    rows = await retryTargets(db, registry, ctx, rows, now);
    expect(rows[0]).toMatchObject({ state: "failed", attempts: 2, nextAttemptAt: now() + 120_000 });
    rows = await retryTargets(db, registry, ctx, rows, now);
    expect(rows[0]).toMatchObject({
      state: "done",
      attempts: 3,
      externalId: "ext-3",
      lastError: null,
      nextAttemptAt: null,
    });
    // A done target is left alone.
    await retryTargets(db, registry, ctx, rows, now);
    expect(flaky.calls).toBe(3);
  });

  it("gives up after the sixth failure", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a", "fail"));
    let rows = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    rows = await executeTargets(db, registry, ctx, rows, now);
    for (let i = 0; i < 5; i++) rows = await retryTargets(db, registry, ctx, rows, now);
    expect(rows[0]).toMatchObject({ state: "failed", attempts: 6, nextAttemptAt: null });
  });

  it("retry also runs a target that was left pending", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const rows = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }], 1);
    const [done] = await retryTargets(db, registry, ctx, rows, now);
    expect(done?.state).toBe("done");
    expect(a.performed).toHaveLength(1);
  });

  it("does not record a result over a row that changed underneath it", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a"));
    const stale = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    // Someone else (an Undo) got there first.
    await db.update(statusTargets).set({ state: "undone" }).where(eq(statusTargets.statusId, "S1"));
    const [row] = await executeTargets(db, registry, ctx, stale, now);
    expect(row).toMatchObject({ state: "undone", attempts: 0 });
    expect(await db.select().from(audit)).toHaveLength(0);
  });

  it("keeps the external id of a successful write in the audit trail", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a"));
    const rows = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    await executeTargets(db, registry, ctx, rows, now);
    const trail = await db.select().from(audit);
    expect(trail[0]).toMatchObject({ action: "a.set", result: "done", detail: "ext-1" });
  });

  it("returns targets in a steady order", async () => {
    const registry = new ConnectorRegistry()
      .register(new RecordingConnector("b"))
      .register(new RecordingConnector("a"));
    const rows = await createTargets(db, "S1", [
      { system: "b", op: "set", args: {} },
      { system: "a", op: "set", args: {} },
    ]);
    const executed = await executeTargets(db, registry, ctx, rows, now);
    expect(executed.map((t) => t.system)).toEqual(["b", "a"]); // the order given
    expect((await targetsForStatus(db, "S1")).map((t) => t.system)).toEqual(["a", "b"]);
  });
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `pnpm exec vitest run packages/core/src/engine/engine.test.ts`
Expected: FAIL. `MAX_ATTEMPTS`, `nextAttemptAfter` and `retryTargets` are not exported from `./engine`.

- [ ] **Step 4: Add the column and the indexes**

In `packages/core/src/db/schema.ts`, in the `statuses` table's index list, add a fourth index:

```ts
  (t) => [
    index("statuses_person_state_idx").on(t.personId, t.state),
    index("statuses_workspace_idx").on(t.workspaceId),
    index("statuses_undo_until_idx").on(t.undoUntilMs),
    /** The tick asks for "scheduled and due" and "active and over" every minute. */
    index("statuses_state_start_idx").on(t.state, t.startMs),
  ],
```

In the `statusTargets` table add the column after `lastError`, and the second index:

```ts
    lastError: text("last_error"),
    /** When the tick should try this write (again). Null when nothing is waiting: done, skipped, undone, or given up. */
    nextAttemptAt: integer("next_attempt_at"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (t) => [
    index("status_targets_status_idx").on(t.statusId),
    index("status_targets_retry_idx").on(t.state, t.nextAttemptAt),
  ],
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @steward/core db:generate`
Expected: a new file `packages/core/drizzle/0006_<two random words>.sql` and an updated `packages/core/drizzle/meta/` folder. The SQL file must contain exactly these three statements (each followed by `--> statement-breakpoint` except the last; their order may differ):

```sql
ALTER TABLE `status_targets` ADD `next_attempt_at` integer;
CREATE INDEX `status_targets_retry_idx` ON `status_targets` (`state`,`next_attempt_at`);
CREATE INDEX `statuses_state_start_idx` ON `statuses` (`state`,`start_ms`);
```

If the file contains anything else (a dropped table, a recreated table), stop and report it. Do not edit the file by hand.

- [ ] **Step 6: Rewrite the engine**

Replace the whole of `packages/core/src/engine/engine.ts` with:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { audit, statusTargets, type TargetRow } from "../db/schema";
import { newId } from "../ids";
import { type ActorCtx, type ConnectorRegistry, SkipWrite, type WriteSpec } from "./connector";

export type TargetState = "pending" | "done" | "failed" | "skipped" | "undone";

/** A write is tried this many times in all before Steward gives up and tells the person. */
export const MAX_ATTEMPTS = 6;
const FIRST_RETRY_MS = 60_000;

/** When a write that has failed `attempts` times is tried again: 1, 2, 4, 8, 16 minutes later. Null once it has used every try. */
export function nextAttemptAfter(attempts: number, at: number): number | null {
  return attempts >= MAX_ATTEMPTS ? null : at + FIRST_RETRY_MS * 2 ** (attempts - 1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The rows for these ids, in the order the ids were given. */
async function targetsById(db: Db, ids: string[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(statusTargets).where(inArray(statusTargets.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** A status's targets, always in the same order (system, then op), so its card reads the same every time. */
export async function targetsForStatus(db: Db, statusId: string): Promise<TargetRow[]> {
  return db
    .select()
    .from(statusTargets)
    .where(eq(statusTargets.statusId, statusId))
    .orderBy(statusTargets.system, statusTargets.op);
}

/**
 * One pending row per write. The idempotency key is stable across retries of the same status.
 * `recoverAt` is when the tick may pick the row up if it is still pending then (the work that
 * should have run it never finished).
 */
export async function createTargets(
  db: Db,
  statusId: string,
  specs: WriteSpec[],
  recoverAt: number | null = null,
): Promise<TargetRow[]> {
  const rows: TargetRow[] = specs.map((spec) => ({
    id: newId(),
    statusId,
    system: spec.system,
    op: spec.op,
    spec: JSON.stringify(spec),
    state: "pending",
    externalId: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: recoverAt,
    idempotencyKey: `${statusId}:${spec.system}:${spec.op}`,
  }));
  if (rows.length > 0) await db.insert(statusTargets).values(rows);
  return rows;
}

type Patch = { state: TargetState; externalId?: string | null; lastError: string | null };

/**
 * Writes a target's new state and its audit row. The update only lands if the row is still as
 * it was read (same state, same number of attempts); if something else changed it meanwhile,
 * nothing is written and the answer is false.
 */
async function record(
  db: Db,
  ctx: ActorCtx,
  target: TargetRow,
  action: string,
  patch: Patch,
  at: number,
  result: TargetState | "undo_failed" = patch.state,
): Promise<boolean> {
  const attempts = target.attempts + 1;
  const updated = await db
    .update(statusTargets)
    .set({
      ...patch,
      attempts,
      nextAttemptAt: patch.state === "failed" ? nextAttemptAfter(attempts, at) : null,
    })
    .where(
      and(
        eq(statusTargets.id, target.id),
        eq(statusTargets.state, target.state),
        eq(statusTargets.attempts, target.attempts),
      ),
    )
    .returning({ id: statusTargets.id });
  if (updated.length === 0) return false;
  await db.insert(audit).values({
    id: newId(),
    workspaceId: ctx.workspaceId,
    personId: ctx.personId,
    action,
    result,
    detail: patch.lastError ?? patch.externalId ?? null,
    at,
    idempotencyKey: target.idempotencyKey,
  });
  return true;
}

async function run(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  targets: TargetRow[],
  now: () => number,
  from: readonly TargetState[],
): Promise<TargetRow[]> {
  for (const target of targets) {
    if (!from.includes(target.state as TargetState)) continue;
    const spec = JSON.parse(target.spec) as WriteSpec;
    const connector = registry.get(target.system);
    let patch: Patch;
    if (!connector) {
      patch = { state: "skipped", lastError: `no connector for ${target.system}` };
    } else {
      try {
        const { externalId } = await connector.perform(spec, {
          ...ctx,
          idempotencyKey: target.idempotencyKey,
        });
        patch = { state: "done", externalId, lastError: null };
      } catch (err) {
        patch =
          err instanceof SkipWrite
            ? { state: "skipped", lastError: err.reason }
            : { state: "failed", lastError: errorMessage(err) };
      }
    }
    await record(db, ctx, target, `${target.system}.${target.op}`, patch, now());
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}

/** Runs every pending target independently; one failure never blocks another. */
export async function executeTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  return run(db, registry, ctx, targets, now, ["pending"]);
}

/** Tries failed targets again, and runs targets that were left pending. Done, skipped and undone ones are left alone. */
export async function retryTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  return run(db, registry, ctx, targets, now, ["pending", "failed"]);
}

/** Reverses done targets through their connector; pending ones simply become undone; failed ones stay failed. */
export async function undoTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  for (const target of targets) {
    const action = `${target.system}.${target.op}.undo`;
    if (target.state === "pending") {
      await record(db, ctx, target, action, { state: "undone", lastError: null }, now());
      continue;
    }
    if (target.state !== "done") continue;
    const spec = JSON.parse(target.spec) as WriteSpec;
    const connector = registry.get(target.system);
    let patch: Patch;
    let result: TargetState | "undo_failed" | undefined;
    if (!connector) {
      result = "undo_failed";
      patch = { state: "done", lastError: `no connector for ${target.system}; could not undo` };
    } else {
      try {
        await connector.undo(target.externalId ?? "", spec, {
          ...ctx,
          idempotencyKey: target.idempotencyKey,
        });
        patch = { state: "undone", lastError: null };
      } catch (err) {
        result = "undo_failed";
        patch = { state: "done", lastError: `undo didn't go through — ${errorMessage(err)}` };
      }
    }
    await record(db, ctx, target, action, patch, now(), result);
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}
```

Before replacing the file, compare `undoTargets` above with the one in the file today. Its behaviour must not change in this task except through `record` (the guard, `nextAttemptAt`, the audit detail). If today's version differs in any other way, keep today's logic and report the difference.

Known limit, accepted: the guard in `record` runs after the outside write. Two ticks overlapping could both set the same Slack status before one of them loses the guard. Setting a Slack status twice with the same values is harmless.

- [ ] **Step 7: Export the new names**

In `packages/core/src/index.ts` replace the engine export line with:

```ts
export {
  createTargets,
  executeTargets,
  MAX_ATTEMPTS,
  nextAttemptAfter,
  retryTargets,
  targetsForStatus,
  undoTargets,
} from "./engine/engine";
```

- [ ] **Step 8: Fix the one fixture that builds a `TargetRow` by hand**

In `packages/availability/src/status/card.test.ts`, the `target` helper becomes:

```ts
const target = (
  state: string,
  lastError: string | null = null,
  nextAttemptAt: number | null = null,
): TargetRow => ({
  id: "G1",
  statusId: "S1",
  system: "slack-status",
  op: "set",
  spec: "{}",
  state,
  externalId: null,
  attempts: 1,
  lastError,
  nextAttemptAt,
  idempotencyKey: "S1:slack-status:set",
});
```

- [ ] **Step 9: Run everything**

Run: `pnpm test`
Expected: PASS. If an older engine test expected the audit `detail` of a successful write to be `null`, change that expectation to the external id the test's connector returns (`"ext-1"`); that is the behaviour this task introduces.

Run: `pnpm typecheck` and `pnpm lint`
Expected: both clean. If `pnpm typecheck` names another file that builds a `TargetRow` literal, add `nextAttemptAt: null` there.

- [ ] **Step 10: Commit**

```bash
git add packages/core packages/availability/src/status/card.test.ts
git commit -m "feat(core): the engine records results safely and can retry a failed write

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Steward can send a person a message

**Files:**
- Modify: `packages/core/src/slack/client.ts`
- Modify: `packages/core/src/slack/fake.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/worker/src/demo/slackClient.ts`
- Modify: `apps/web/src/demo/api.ts`
- Modify: `apps/web/src/demo/model.ts`
- Test: `packages/core/src/slack/client.test.ts`, `packages/core/src/slack/fake.test.ts`, `apps/worker/test/demoSlackClient.test.ts` (new), `apps/web/src/demo/model.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type PostMessageArgs = { botToken: string; channel: string; text: string; blocks?: Block[] }` (exported from `@steward/core`)
  - `SlackClient.postMessage(args: PostMessageArgs): Promise<void>`; `channel` is a Slack user id for a direct message
  - `FakeSlackClient.messages: PostMessageArgs[]`
  - demo event kind `"message"` with payload `{ channel: string; text: string; blocks: Block[] }`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/slack/client.test.ts`, inside `describe("RealSlackClient", …)`:

```ts
  it("posts a message with the bot token", async () => {
    const fetchFn = fetchReturning({ ok: true });
    const slack = new RealSlackClient(fetchFn);
    await slack.postMessage({ botToken: "xoxb-1", channel: "U_DANA", text: "hello" });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "U_DANA", text: "hello" });
  });

  it("fails loudly when Slack refuses the message", async () => {
    const slack = new RealSlackClient(fetchReturning({ ok: false, error: "channel_not_found" }));
    await expect(
      slack.postMessage({ botToken: "xoxb-1", channel: "U_NOBODY", text: "hello" }),
    ).rejects.toThrow("chat.postMessage: channel_not_found");
  });
```

(The neighbouring tests in that file show how the existing methods' headers and errors are asserted. If they read the header under a different key or expect a different error text, follow them; the request URL and body above are what matters.)

In `packages/core/src/slack/fake.test.ts`, inside `describe("FakeSlackClient", …)`:

```ts
  it("records messages and can fail the next one", async () => {
    const slack = new FakeSlackClient();
    await slack.postMessage({ botToken: "xoxb", channel: "U1", text: "hello" });
    expect(slack.messages).toEqual([{ botToken: "xoxb", channel: "U1", text: "hello" }]);
    slack.failNext.postMessage = "channel_not_found";
    await expect(
      slack.postMessage({ botToken: "xoxb", channel: "U1", text: "again" }),
    ).rejects.toThrow("channel_not_found");
    expect(slack.messages).toHaveLength(1);
  });
```

Create `apps/worker/test/demoSlackClient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DemoSlackClient, readDemoEvents } from "../src/demo/slackClient";
import { NOW, testDeps } from "./helpers";

describe("the demo's Slack", () => {
  it("records a message without the token that sent it", async () => {
    const deps = testDeps();
    const slack = new DemoSlackClient(deps.db, "s1", () => NOW);
    await slack.postMessage({ botToken: "xoxb-demo", channel: "U_DANA", text: "hello" });
    const events = await readDemoEvents(deps.db, "s1");
    expect(events.map((e) => e.kind)).toEqual(["message"]);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
      channel: "U_DANA",
      text: "hello",
      blocks: [],
    });
  });
});
```

(If `demo_events` rows need an existing `demo_sessions` row, or `readDemoEvents` returns parsed payloads, follow how `apps/worker/test/demo.test.ts` creates a session and reads events; the assertion that matters is one `message` event whose payload is `{ channel, text, blocks: [] }` with no token.)

In `apps/web/src/demo/model.test.ts`, inside `describe("deriveScreen", …)`:

```ts
  it("shows a message Steward sent, in the thread, and never mistakes it for a status", () => {
    const events: DemoEvent[] = [
      response(1, "receipt"),
      { seq: 2, kind: "message", at: 2000, payload: { channel: "U_DANA", text: "heads up", blocks: [] } },
    ];
    const screen = deriveScreen({ now: 0, events }, none);
    expect(screen.messages.map((m) => `${m.seq}:${m.text}`)).toEqual(["1:receipt", "2:heads up"]);
    expect(screen.statuses).toEqual({});
  });
```

(Call `deriveScreen` the way the other tests in that file do, and name the status field the way they do.)

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm exec vitest run packages/core/src/slack apps/worker/test/demoSlackClient.test.ts apps/web/src/demo/model.test.ts`
Expected: FAIL. `postMessage` does not exist on the three clients, and `"message"` is not a `DemoEvent` kind.

- [ ] **Step 3: Add `postMessage` to the interface and the real client**

In `packages/core/src/slack/client.ts`, after the `SetStatusArgs` type add:

```ts
/** `channel` is a channel id, or a user id to reach the person in the app's direct messages. */
export type PostMessageArgs = { botToken: string; channel: string; text: string; blocks?: Block[] };
```

Add to the `SlackClient` interface, after `getUserInfo`:

```ts
  /** Sends a message as the app. Needs the bot scope `chat:write`. */
  postMessage(args: PostMessageArgs): Promise<void>;
```

Add to `RealSlackClient`, after `clearUserStatus`:

```ts
  async postMessage(args: PostMessageArgs): Promise<void> {
    await this.call("chat.postMessage", args.botToken, {
      channel: args.channel,
      text: args.text,
      blocks: args.blocks,
    });
  }
```

(`JSON.stringify` drops `blocks` when it is `undefined`, which is what the first test expects.)

- [ ] **Step 4: Add it to the fake**

In `packages/core/src/slack/fake.ts`, add `type PostMessageArgs,` to the import from `./client`, add the field after `responses`:

```ts
  messages: PostMessageArgs[] = [];
```

and the method after `clearUserStatus`:

```ts
  async postMessage(args: PostMessageArgs): Promise<void> {
    this.maybeFail("postMessage");
    this.messages.push(args);
  }
```

In `packages/core/src/index.ts`, add `PostMessageArgs` to the type export from `./slack/client`.

- [ ] **Step 5: Add it to the demo's Slack**

In `apps/worker/src/demo/slackClient.ts`, add `type PostMessageArgs,` to the import from `@steward/core`, change the kind type:

```ts
export type DemoEventKind = "view" | "response" | "status" | "message";
```

and add the method after `clearUserStatus`:

```ts
  /** The recorded message names where it went and never carries the token. */
  async postMessage(args: PostMessageArgs): Promise<void> {
    await this.record("message", {
      channel: args.channel,
      text: args.text,
      blocks: args.blocks ?? [],
    });
  }
```

In `packages/core/src/db/schema.ts`, if the comment above `demoEvents` lists the event kinds, add the fourth: `` `message` (chat.postMessage) ``. A comment change makes no migration.

- [ ] **Step 6: Teach the emulator the new event**

In `apps/web/src/demo/api.ts`, add a fourth member to the `DemoEvent` union:

```ts
  | {
      seq: number;
      kind: "message";
      at: number;
      payload: { channel: string; text: string; blocks: Block[] };
    };
```

(Move the `;` that ended the union so it ends after this member.)

In `apps/web/src/demo/model.ts`, in `deriveScreen`, put a new branch between the `response` branch and the final `else` (which treats every remaining event as a status event):

```ts
    } else if (event.kind === "message") {
      const { text, blocks } = event.payload;
      messages.push({ seq: event.seq, at: event.at, text, blocks });
    } else {
```

- [ ] **Step 7: Run everything**

Run: `pnpm test`, then `pnpm typecheck`, then `pnpm lint`
Expected: all pass. If `pnpm typecheck` names another class that implements `SlackClient` (a test double somewhere), give it a `postMessage` that records its argument.

- [ ] **Step 8: Commit**

```bash
git add packages/core apps/worker apps/web
git commit -m "feat(slack): the app can send a person a message; the demo records it

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: A status can be saved ahead and cancelled before it starts

**Files:**
- Modify: `packages/availability/src/status/form.ts:104-121`
- Modify: `packages/availability/src/status/service.ts`
- Modify: `packages/availability/src/status/card.ts`
- Modify: `packages/availability/src/index.ts`
- Test: `packages/availability/src/status/form.test.ts`, `service.test.ts`, `card.test.ts`
- Test: `apps/worker/test/ooo.test.ts:140-151`

**Interfaces:**
- Consumes (Task 1): `createTargets(db, statusId, specs, recoverAt: number | null = null)`; `TargetRow.nextAttemptAt: number | null`.
- Produces:
  - `MAX_DAYS_AHEAD = 365` (form.ts)
  - `RECOVERY_DELAY_MS = 120_000` (service.ts): how long after a write should have happened the tick may pick it up.
  - `CANCEL_TOO_LATE = "That status has already started — Cancel works only before the first day."` (service.ts)
  - `scheduledStatusesFor(db: Db, personId: string, limit: number): Promise<StatusRow[]>`, earliest first.
  - A scheduled status is saved with `undoUntilMs = startMs`; its targets with `nextAttemptAt = startMs + RECOVERY_DELAY_MS`. An active status's targets are created with `nextAttemptAt = now + RECOVERY_DELAY_MS` (the engine clears it when the write is recorded).
  - `resultCard` titles: `Scheduled · …` (state `scheduled`), `Cancelled · …` (cancelled, saved ahead), `Undone · …` (cancelled, started at once). The button of a scheduled status reads `Cancel`; its `action_id` is still `UNDO_ACTION`.

- [ ] **Step 1: Write the failing form tests**

In `packages/availability/src/status/form.test.ts`, replace the whole test `"refuses a first day in the future until scheduling exists"` with:

```ts
  it("accepts a first day in the future", () => {
    const r = readStatusSubmission(
      values({ type: "out", from: "2026-11-13", to: "2026-11-14" }),
      today,
    );
    expect(r.ok && r.input).toMatchObject({ from: "2026-11-13", to: "2026-11-14" });
  });

  it("accepts a first day a year ahead and refuses one a day later", () => {
    const edge = readStatusSubmission(
      values({ type: "out", from: "2027-11-12", to: "2027-11-12" }),
      today,
    );
    expect(edge.ok).toBe(true);
    const far = readStatusSubmission(
      values({ type: "out", from: "2027-11-13", to: "2027-11-13" }),
      today,
    );
    expect(far).toEqual({ ok: false, errors: { from: "Pick a first day within the next year." } });
  });
```

Use the helper names the neighbouring tests in that file use for the submitted values and for today (`2026-11-12`); if they differ from `values` and `today`, use the file's.

- [ ] **Step 2: Write the failing service tests**

In `packages/availability/src/status/service.test.ts`, add `CANCEL_TOO_LATE`, `RECOVERY_DELAY_MS` and `scheduledStatusesFor` to the import from `./service`. In the test `"a future status is saved as scheduled and writes nothing yet"`, add after the existing assertions:

```ts
    expect(status.undoUntilMs).toBe(status.startMs);
    expect(targets[0]?.nextAttemptAt).toBe(status.startMs + RECOVERY_DELAY_MS);
```

Add these tests inside the same `describe`:

```ts
  it("a written target has no recovery time left", async () => {
    const { targets } = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    expect(targets[0]?.state).toBe("done");
    expect(targets[0]?.nextAttemptAt).toBeNull();
  });

  it("a scheduled status can be cancelled days later, as long as it has not started", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    clock = NOW + 3 * 24 * 60 * 60 * 1000;
    const result = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
    if ("error" in result) throw new Error(result.error);
    expect(result.status.state).toBe("cancelled");
    expect(result.targets[0]?.state).toBe("undone");
    expect(slack.statuses.size).toBe(0);
  });

  it("refuses to cancel once the first day has begun, in plain words", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    clock = saved.status.startMs;
    expect(await undoStatus(deps, saved.status.id, dana, "xoxp-dana")).toEqual({
      error: CANCEL_TOO_LATE,
    });
  });

  it("lists a person's scheduled statuses, earliest first, up to a limit", async () => {
    const save = (day: string) =>
      saveStatus(
        deps,
        dana,
        { type: "out", from: day, to: day, text: "Out", emoji: ":x:" },
        "xoxp-dana",
      );
    await save("2026-11-12"); // active today: not listed
    const later = await save("2026-11-25");
    const sooner = await save("2026-11-20");
    expect((await scheduledStatusesFor(deps.db, dana.id, 5)).map((s) => s.id)).toEqual([
      sooner.status.id,
      later.status.id,
    ]);
    expect(await scheduledStatusesFor(deps.db, dana.id, 1)).toHaveLength(1);
  });
```

The names `deps`, `dana`, `slack`, `clock` and `NOW` are the ones the existing tests in that file set up in `beforeEach`; use the file's own if any differs.

- [ ] **Step 3: Write the failing card tests**

In `packages/availability/src/status/card.test.ts`, add inside `describe("resultCard", …)`:

```ts
  it("a scheduled status says so and offers Cancel until it starts", () => {
    const startMs = now + 2 * 86_400_000;
    const scheduled = { ...status, state: "scheduled", startMs, undoUntilMs: startMs };
    const card = resultCard({
      status: scheduled,
      targets: [{ ...target("pending"), attempts: 0 }],
      tz: "UTC",
      now,
    });
    expect(card.text.startsWith("Scheduled · Out of office · ")).toBe(true);
    const json = JSON.stringify(card.blocks);
    expect(json).toContain('"Cancel"');
    expect(json).not.toContain('"Undo"');
    expect(json).toContain("You can cancel until it starts (");
  });

  it("a status cancelled before it started is called cancelled, and nothing was cleared", () => {
    const startMs = now + 2 * 86_400_000;
    const card = resultCard({
      status: { ...status, state: "cancelled", startMs, undoUntilMs: null },
      targets: [{ ...target("undone"), attempts: 1 }],
      tz: "UTC",
      now,
    });
    expect(card.text.startsWith("Cancelled · Out of office · ")).toBe(true);
    const json = JSON.stringify(card.blocks);
    expect(json).toContain("↩️ Slack status — won't be set");
    expect(json).not.toContain("cleared");
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
  });
```

- [ ] **Step 4: Replace the worker test that expects the refusal**

In `apps/worker/test/ooo.test.ts`, replace the whole test `"refuses a first day in the future with a plain field error, before saving anything"` with:

```ts
  it("saves a future first day as scheduled: Slack untouched, the receipt offers Cancel, Cancel calls it off", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-13", to: "2026-11-14" })),
    });
    expect(res.status).toBe(200);
    await flush(deps);
    const receipt = deps.slack.responses[0];
    expect(receipt?.text).toMatch(/^Scheduled · Out of office · /);
    expect(deps.slack.statuses.size).toBe(0);
    const statusId = undoValue(receipt?.blocks ?? []);
    expect(statusId).toBeTruthy();

    const cancel = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U_DANA", username: "dana" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    });
    expect(cancel.status).toBe(200);
    await flush(deps);
    expect(deps.slack.responses[1]?.replaceOriginal).toBe(true);
    expect(deps.slack.responses[1]?.text).toMatch(/^Cancelled · Out of office/);
    expect(deps.slack.statuses.size).toBe(0);
  });
```

This file already has a helper that reads the status id out of a receipt's Undo button and a helper that waits for deferred work; the existing Undo test (around line 97) uses both. Use those helpers under their own names in place of `undoValue` and `flush` if they are named differently.

- [ ] **Step 5: Run the tests and see them fail**

Run: `pnpm --filter @steward/availability exec vitest run` and `pnpm --filter @steward/worker exec vitest run test/ooo.test.ts`
Expected: FAIL. The form still answers "Scheduling arrives in a later version…", `CANCEL_TOO_LATE`, `RECOVERY_DELAY_MS` and `scheduledStatusesFor` are not exported, and the card says neither "Scheduled" nor "Cancel".

- [ ] **Step 6: Let the form accept a future first day**

In `packages/availability/src/status/form.ts`, add above the doc comment of `readStatusSubmission`:

```ts
/** The furthest ahead a status may start. */
export const MAX_DAYS_AHEAD = 365;

const lastFirstDay = (today: string): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS_AHEAD * 86_400_000)
    .toISOString()
    .slice(0, 10);
```

Replace the doc comment of `readStatusSubmission` with:

```ts
/**
 * Reads the submitted form. `today` is the person's local date: the first day may be today, earlier,
 * or up to a year ahead (a later first day is saved as scheduled), and the last day may not already be over.
 */
```

Replace these two lines:

```ts
  else if (from > opts.today)
    errors[FIELD.from] = "Scheduling arrives in a later version — for now, the first day is today.";
```

with:

```ts
  else if (from > lastFirstDay(opts.today))
    errors[FIELD.from] = "Pick a first day within the next year.";
```

- [ ] **Step 7: Save ahead, cancel before the start, list what is scheduled**

In `packages/availability/src/status/service.ts`:

Add `asc` to the `drizzle-orm` import. Below `UNDO_WINDOW_MS` add:

```ts
/** A write still pending this long after it was due is picked up by the tick. */
export const RECOVERY_DELAY_MS = 2 * 60 * 1000;
export const CANCEL_TOO_LATE =
  "That status has already started — Cancel works only before the first day.";
```

Below `activeStatusFor` add:

```ts
/** The person's statuses that have not started yet, earliest first. */
export async function scheduledStatusesFor(
  db: Db,
  personId: string,
  limit: number,
): Promise<StatusRow[]> {
  return db
    .select()
    .from(schema.statuses)
    .where(and(eq(schema.statuses.personId, personId), eq(schema.statuses.state, "scheduled")))
    .orderBy(asc(schema.statuses.startMs))
    .limit(limit);
}
```

In `saveStatus`, replace the `undoUntilMs` line of the status row with:

```ts
    // A scheduled status can be cancelled until it starts; one that starts now can be undone for five minutes.
    undoUntilMs: state === "scheduled" ? startMs : now + UNDO_WINDOW_MS,
```

and replace the `createTargets` call with:

```ts
  let targets = await createTargets(
    deps.db,
    status.id,
    planWrites(input, { startMs, endMs }),
    (state === "scheduled" ? startMs : now) + RECOVERY_DELAY_MS,
  );
```

(keep the declaration keyword, `let` or `const`, that the existing line uses). Reword the comment near line 51 that mentions "(Plan 3)" to say that scheduled statuses leave their targets pending until the tick starts them.

In `undoStatus`, replace the check that returns `"The five-minute undo window has passed."` with:

```ts
  if (status.undoUntilMs === null || status.undoUntilMs <= deps.now()) {
    // Saved ahead of its first day: what has run out is the time before the start, not five minutes.
    return {
      error:
        status.startMs > status.createdAt
          ? CANCEL_TOO_LATE
          : "The five-minute undo window has passed.",
    };
  }
```

Keep the comparison operator the existing check uses if it is `<` rather than `<=`, except that the test in Step 2 (`clock = startMs`) must be refused: a status may not be cancelled at the instant it starts.

- [ ] **Step 8: Word the card**

In `packages/availability/src/status/card.ts`, add below `SYSTEM_NAME`:

```ts
/** True for a status that was saved before its first day. */
const savedAhead = (status: StatusRow): boolean => status.startMs > status.createdAt;

function titlePrefix(status: StatusRow): string {
  if (status.state === "scheduled") return "Scheduled · ";
  if (status.state !== "cancelled") return "";
  return savedAhead(status) ? "Cancelled · " : "Undone · ";
}
```

In `targetLine`, replace the `undone` case with:

```ts
    case "undone":
      return savedAhead(status) ? `↩️ ${name} — won't be set` : `↩️ ${name} cleared`;
```

(`name` stands for whatever local the existing case uses for the system's display name.)

In `resultCard`, build the title as `${titlePrefix(status)}${label} · ${range}` in place of the existing `Undone · ` conditional, and replace the two `blocks.push` lines inside the "can undo" branch with:

```ts
    const scheduled = status.state === "scheduled";
    blocks.push(
      actions(button(scheduled ? "Cancel" : "Undo", UNDO_ACTION, { value: status.id, style: "danger" })),
    );
    blocks.push(
      context(
        scheduled
          ? `You can cancel until it starts (${formatDay(status.startMs, tz)}).`
          : `You can undo until ${formatTime(status.undoUntilMs, tz)}.`,
      ),
    );
```

Keep the button's existing options (value, style) exactly as the current Undo button has them; only the label and the context sentence change. `formatDay` is the day formatter `formatRange` is built on in `packages/availability/src/time.ts`; if it is not exported, export it.

- [ ] **Step 9: Export the new names**

In `packages/availability/src/index.ts`, add `MAX_DAYS_AHEAD` to the names exported from `./status/form`, and `CANCEL_TOO_LATE`, `RECOVERY_DELAY_MS`, `scheduledStatusesFor` to the names exported from `./status/service`.

- [ ] **Step 10: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. If `pnpm lint` reports formatting, run `pnpm exec biome check --write .` and run it again. Then `grep -rn "later version" apps packages --include=*.ts --include=*.tsx` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add packages/availability apps/worker/test/ooo.test.ts
git commit -m "feat(availability): a status can be saved ahead and cancelled before it starts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: The tick starts, ends and retries statuses

**Files:**
- Modify: `apps/worker/src/tick.ts` (rewritten in full below)
- Test: `apps/worker/test/tick.test.ts`
- Test: `apps/worker/test/demo.d1.smoke.test.ts` (the cleanup test's bound, and one new case)

**Interfaces:**
- Consumes: `executeTargets`, `retryTargets`, `targetsForStatus`, `MAX_ATTEMPTS`, `open`, `ConnectorRegistry`, `schema` from `@steward/core`; `SlackClient.postMessage({ botToken, channel, text })` and `FakeSlackClient.messages` (Task 2); `SlackStatusConnector`, `STATUS_LABEL`, `StatusType`, `formatRange` from `@steward/availability`; statuses saved by Task 3.
- Produces:
  - `type TickDeps = Pick<Deps, "db" | "now" | "slack" | "tokenKey">`
  - `type TickScope = { workspaceId?: string }`: no `workspaceId` means every workspace whose id does not begin with `demo:`.
  - `type TickLimits = { starts: number; retries: number }`; `TICK_LIMITS = { starts: 3, retries: 2 }`; `DEMO_TICK_LIMITS = { starts: 2, retries: 1 }`
  - `type StatusSteps = { scheduledEnded: number; ended: number; started: number; retried: number }`
  - `runStatusSteps(deps: TickDeps, scope: TickScope, limits?: TickLimits): Promise<StatusSteps>`
  - `runTick(deps: TickDeps): Promise<StatusSteps & { undoWindowsExpired: number; demoSessionsRemoved: number }>`

**The budget this task must keep** (D1 statements; the engine costs 3 per target: guarded update, audit row, re-read):

| Step | Statements | Slack calls |
|---|---|---|
| close undo windows | 1 | 0 |
| end scheduled statuses whose days all passed | 1 | 0 |
| end active statuses whose last day is over | 1 | 0 |
| find due starts | 1 | 0 |
| each start (at most 3): claim 1, end the earlier one 1, read targets 1, write 3 | 6 each, 18 | 1 each, 3 |
| find due retries | 1 | 0 |
| each retry (at most 2): write 3 | 3 each, 6 | 2 each (the write, and the give-up message), 4 |
| clean up demo sessions (unchanged) | at most 15 | 0 |
| **Total** | **44** | **7** |

The workspace's bot token is joined into the two "find" queries so that sending a message costs no further statement.

- [ ] **Step 1: Write the failing tests**

Replace `apps/worker/test/tick.test.ts` with:

```ts
import { saveStatus, SlackStatusConnector, type StatusInput } from "@steward/availability";
import { ConnectorRegistry, ensurePerson, type PersonRow, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDemoSession, DEMO_SESSION_TTL_MS, demoWorkspaceId } from "../src/demo/session";
import { runStatusSteps, runTick } from "../src/tick";
import { NOW, seedWorkspace, type TestDeps, testDeps } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

const availability = (deps: TestDeps) => ({
  db: deps.db,
  registry: new ConnectorRegistry().register(new SlackStatusConnector(deps.slack)),
  now: deps.now,
});
const dana = async (deps: TestDeps): Promise<PersonRow> => {
  const [row] = await deps.db.select().from(schema.people).where(eq(schema.people.id, "T1:U_DANA"));
  if (!row) throw new Error("seed the workspace first");
  return row;
};
const out = (from: string, to: string): StatusInput => ({
  type: "out",
  from,
  to,
  text: "Out of office",
  emoji: ":palm_tree:",
});
const statusRow = async (deps: TestDeps, id: string) =>
  (await deps.db.select().from(schema.statuses).where(eq(schema.statuses.id, id)))[0];
const targetOf = async (deps: TestDeps, statusId: string) =>
  (
    await deps.db
      .select()
      .from(schema.statusTargets)
      .where(eq(schema.statusTargets.statusId, statusId))
  )[0];

describe("tick", () => {
  it("closes undo windows that have passed and leaves open ones alone", async () => {
    const deps = testDeps();
    const base = {
      workspaceId: "T1",
      personId: "T1:U1",
      type: "out",
      startMs: 0,
      endMs: NOW + DAY,
      text: "x",
      emoji: ":x:",
      state: "active",
      source: "form",
      createdAt: 0,
      replacedStatusId: null,
    };
    await deps.db.insert(schema.statuses).values([
      { ...base, id: "old", undoUntilMs: NOW - 1 },
      { ...base, id: "fresh", undoUntilMs: NOW + 60_000 },
      { ...base, id: "none", undoUntilMs: null },
    ]);
    expect(await runTick(deps)).toEqual({
      undoWindowsExpired: 1,
      scheduledEnded: 0,
      ended: 0,
      started: 0,
      retried: 0,
      demoSessionsRemoved: 0,
    });
    expect((await runTick(deps)).undoWindowsExpired).toBe(0);
  });

  it("the tick also cleans expired demo sessions", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect((await runTick(deps)).demoSessionsRemoved).toBe(1);
  });

  it("starts a scheduled status on its first day, quietly, and Cancel is over", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-13", "2026-11-14"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.startMs - 1;
    expect((await runTick(deps)).started).toBe(0);
    expect(deps.slack.statuses.size).toBe(0);

    deps.clock.now = saved.status.startMs;
    expect((await runTick(deps)).started).toBe(1);
    expect(deps.slack.statuses.get("xoxp-dana")).toMatchObject({ text: "Out of office" });
    expect(await statusRow(deps, saved.status.id)).toMatchObject({
      state: "active",
      undoUntilMs: null,
    });
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "done",
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(0);
    expect((await runTick(deps)).started).toBe(0);
  });

  it("a status that starts ends the one that was active and records it as replaced", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await dana(deps);
    const first = await saveStatus(
      availability(deps),
      person,
      out("2026-11-12", "2026-11-16"),
      "xoxp-dana",
    );
    const second = await saveStatus(
      availability(deps),
      person,
      out("2026-11-13", "2026-11-13"),
      "xoxp-dana",
    );
    deps.clock.now = second.status.startMs;
    await runTick(deps);
    expect((await statusRow(deps, first.status.id))?.state).toBe("ended");
    expect(await statusRow(deps, second.status.id)).toMatchObject({
      state: "active",
      replacedStatusId: first.status.id,
    });
  });

  it("tells the person when a status started but Slack was not connected", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await ensurePerson(deps.db, "T1", "U_NOSLACK", "No Slack");
    const saved = await saveStatus(availability(deps), person, out("2026-11-13", "2026-11-13"), null);
    deps.clock.now = saved.status.startMs;
    await runTick(deps);
    expect((await targetOf(deps, saved.status.id))?.state).toBe("skipped");
    expect(deps.slack.messages).toHaveLength(1);
    expect(deps.slack.messages[0]?.channel).toBe("U_NOSLACK");
    expect(deps.slack.messages[0]?.text).toMatch(
      /^Your Out of office status \(.+\) started, but Steward couldn't set your Slack status: Slack isn't connected/,
    );
  });

  it("ends an active status when its last day is over", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-12"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.endMs - 1;
    expect((await runTick(deps)).ended).toBe(0);
    deps.clock.now = saved.status.endMs;
    expect((await runTick(deps)).ended).toBe(1);
    expect((await statusRow(deps, saved.status.id))?.state).toBe("ended");
  });

  it("ends a scheduled status whose days all passed, without touching Slack", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-13", "2026-11-13"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.endMs + 1;
    expect(await runTick(deps)).toMatchObject({ scheduledEnded: 1, started: 0, ended: 0 });
    expect(deps.slack.statuses.size).toBe(0);
    expect((await statusRow(deps, saved.status.id))?.state).toBe("ended");
  });

  it("starts at most three statuses a minute, the earliest first", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const ids: string[] = [];
    for (const [i, user] of ["U_A", "U_B", "U_C", "U_D"].entries()) {
      const person = await ensurePerson(deps.db, "T1", user, user);
      // U_A starts on the 13th, U_B on the 14th, and so on; all are due by the 17th.
      const day = `2026-11-${13 + i}`;
      ids.push(
        (await saveStatus(availability(deps), person, out(day, "2026-11-20"), null)).status.id,
      );
    }
    deps.clock.now = NOW + 5 * DAY;
    expect((await runTick(deps)).started).toBe(3);
    expect((await statusRow(deps, ids[3] ?? ""))?.state).toBe("scheduled");
    expect((await runTick(deps)).started).toBe(1);
  });

  it("tries a failed write again a minute later", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    expect(saved.targets[0]).toMatchObject({ state: "failed", nextAttemptAt: NOW + 60_000 });
    deps.clock.now = NOW + 59_000;
    expect((await runTick(deps)).retried).toBe(0);
    deps.clock.now = NOW + 60_000;
    expect((await runTick(deps)).retried).toBe(1);
    expect(deps.slack.statuses.get("xoxp-dana")).toMatchObject({ text: "Out of office" });
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "done",
      attempts: 2,
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(0);
  });

  it("gives up after the sixth failure and tells the person once", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    for (let attempt = 2; attempt <= 6; attempt++) {
      const target = await targetOf(deps, saved.status.id);
      if (target?.nextAttemptAt == null) throw new Error(`no retry planned before try ${attempt}`);
      deps.clock.now = target.nextAttemptAt;
      deps.slack.failNext.setUserStatus = "ratelimited";
      expect((await runTick(deps)).retried).toBe(1);
    }
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "failed",
      attempts: 6,
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(1);
    expect(deps.slack.messages[0]?.channel).toBe("U_DANA");
    expect(deps.slack.messages[0]?.text).toMatch(
      /^Steward tried six times to set your Slack status for Out of office \(.+\) and it didn't go through/,
    );
    deps.clock.now += DAY / 2;
    expect((await runTick(deps)).retried).toBe(0);
    expect(deps.slack.messages).toHaveLength(1);
  });

  it("does not retry a write whose status is no longer active", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await dana(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const failed = await saveStatus(
      availability(deps),
      person,
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    await saveStatus(availability(deps), person, out("2026-11-12", "2026-11-12"), "xoxp-dana");
    deps.clock.now = NOW + 60_000;
    expect((await runTick(deps)).retried).toBe(0);
    expect((await targetOf(deps, failed.status.id))?.state).toBe("failed");
  });

  it("the every-minute tick leaves demo workspaces alone; a demo session runs its own steps", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const workspaceId = demoWorkspaceId(s.id);
    await deps.db.insert(schema.statuses).values({
      id: "S_DEMO",
      workspaceId,
      personId: s.youPersonId,
      type: "out",
      startMs: NOW - 1,
      endMs: NOW + DAY,
      text: "Out of office",
      emoji: ":palm_tree:",
      state: "scheduled",
      source: "form",
      createdAt: NOW - DAY,
      undoUntilMs: null,
      replacedStatusId: null,
    });
    expect((await runTick(deps)).started).toBe(0);
    expect((await statusRow(deps, "S_DEMO"))?.state).toBe("scheduled");
    expect((await runStatusSteps(deps, { workspaceId })).started).toBe(1);
    expect((await statusRow(deps, "S_DEMO"))?.state).toBe("active");
  });
});
```

Before running, check three things against `apps/worker/test/helpers.ts` and adjust the test, not the helper: the seeded person's id (`T1:U_DANA`) and user token (`xoxp-dana`); that `deps.slack` is the `FakeSlackClient`; and that `deps.clock.now` is how tests move time.

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @steward/worker exec vitest run test/tick.test.ts`
Expected: FAIL. `runStatusSteps` is not exported from `../src/tick`, and `runTick` returns only two counts.

- [ ] **Step 3: Rewrite the tick**

Replace `apps/worker/src/tick.ts` with:

```ts
import {
  formatRange,
  SlackStatusConnector,
  STATUS_LABEL,
  type StatusType,
} from "@steward/availability";
import {
  ConnectorRegistry,
  executeTargets,
  MAX_ATTEMPTS,
  open,
  type PersonRow,
  retryTargets,
  type StatusRow,
  schema,
  targetsForStatus,
} from "@steward/core";
import { and, asc, eq, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import { cleanupDemoSessions } from "./demo/session";
import type { Deps } from "./deps";

export type TickDeps = Pick<Deps, "db" | "now" | "slack" | "tokenKey">;
/** Which statuses a run looks at: one workspace, or (with no id) every workspace that is not a demo. */
export type TickScope = { workspaceId?: string };
export type TickLimits = { starts: number; retries: number };
export type StatusSteps = {
  scheduledEnded: number;
  ended: number;
  started: number;
  retried: number;
};

/**
 * The most the every-minute tick does in one run. With these the worst case is 44 D1 statements and
 * 7 Slack calls; both free plans stop an invocation at 50. Raise them only with that sum redone.
 */
export const TICK_LIMITS: TickLimits = { starts: 3, retries: 2 };
/** A demo request also claims an action, moves the clock and reads its state, so it does less. */
export const DEMO_TICK_LIMITS: TickLimits = { starts: 2, retries: 1 };

const inScope = (scope: TickScope) =>
  scope.workspaceId
    ? eq(schema.statuses.workspaceId, scope.workspaceId)
    : sql`substr(${schema.statuses.workspaceId}, 1, 5) <> 'demo:'`;

const registryFor = (deps: TickDeps) =>
  new ConnectorRegistry().register(new SlackStatusConnector(deps.slack));

const describeStatus = (status: StatusRow, tz: string): string =>
  `${STATUS_LABEL[status.type as StatusType] ?? status.type} (${formatRange(status.startMs, status.endMs, tz)})`;

async function userTokenOf(deps: TickDeps, person: PersonRow): Promise<string | null> {
  if (!person.userTokenSealed) return null;
  try {
    return await open(deps.tokenKey, person.userTokenSealed);
  } catch (err) {
    console.error("user token unreadable", { person: person.id, err });
    return null;
  }
}

/** A direct message from Steward. A message that cannot be sent is logged, never thrown. */
async function tell(
  deps: TickDeps,
  botTokenSealed: string,
  person: PersonRow,
  text: string,
): Promise<void> {
  try {
    const botToken = await open(deps.tokenKey, botTokenSealed);
    await deps.slack.postMessage({ botToken, channel: person.slackUserId, text });
  } catch (err) {
    console.error("could not message the person", { person: person.id, err });
  }
}

/** Undo windows that have passed are closed so the card stops offering Undo. One statement, whatever the number. */
export async function expireUndoWindows(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const closed = await deps.db
    .update(schema.statuses)
    .set({ undoUntilMs: null })
    .where(and(isNotNull(schema.statuses.undoUntilMs), lt(schema.statuses.undoUntilMs, deps.now())))
    .returning({ id: schema.statuses.id });
  return closed.length;
}

/**
 * Marks statuses in `state` whose last day is over as ended. For `scheduled` that means the days
 * passed without the status ever starting; nothing was written, so nothing is cleared. For `active`
 * Slack clears the status itself at the expiration it was given. One statement.
 */
async function endPassed(
  deps: TickDeps,
  scope: TickScope,
  state: "scheduled" | "active",
): Promise<number> {
  const ended = await deps.db
    .update(schema.statuses)
    .set({ state: "ended", undoUntilMs: null })
    .where(
      and(eq(schema.statuses.state, state), lte(schema.statuses.endMs, deps.now()), inScope(scope)),
    )
    .returning({ id: schema.statuses.id });
  return ended.length;
}

/** Starts scheduled statuses whose first day has begun, the earliest first. */
async function startDue(deps: TickDeps, scope: TickScope, limit: number): Promise<number> {
  const due = await deps.db
    .select({
      status: schema.statuses,
      person: schema.people,
      botTokenSealed: schema.workspaces.botTokenSealed,
    })
    .from(schema.statuses)
    .innerJoin(schema.people, eq(schema.statuses.personId, schema.people.id))
    .innerJoin(schema.workspaces, eq(schema.statuses.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.statuses.state, "scheduled"),
        lte(schema.statuses.startMs, deps.now()),
        inScope(scope),
      ),
    )
    .orderBy(asc(schema.statuses.startMs))
    .limit(limit);
  let started = 0;
  for (const { status, person, botTokenSealed } of due) {
    try {
      // Claim it: only one run may start a status, and a status cancelled a moment ago must stay cancelled.
      // The same statement notes which status it takes over from.
      const claimed = await deps.db
        .update(schema.statuses)
        .set({
          state: "active",
          undoUntilMs: null,
          replacedStatusId: sql`(select s.id from statuses s where s.person_id = ${status.personId} and s.state = 'active' limit 1)`,
        })
        .where(and(eq(schema.statuses.id, status.id), eq(schema.statuses.state, "scheduled")))
        .returning({ id: schema.statuses.id });
      if (claimed.length === 0) continue;
      started++;
      await deps.db
        .update(schema.statuses)
        .set({ state: "ended", undoUntilMs: null })
        .where(
          and(
            eq(schema.statuses.personId, status.personId),
            eq(schema.statuses.state, "active"),
            ne(schema.statuses.id, status.id),
          ),
        );
      const targets = await executeTargets(
        deps.db,
        registryFor(deps),
        {
          workspaceId: person.workspaceId,
          personId: person.id,
          userToken: await userTokenOf(deps, person),
        },
        await targetsForStatus(deps.db, status.id),
        deps.now,
      );
      // A start is quiet when it works. A failed write is retried below; a skipped one never will be, so say so now.
      const skipped = targets.find((t) => t.state === "skipped");
      if (skipped) {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Your ${describeStatus(status, person.tz)} status started, but Steward couldn't set your Slack status: ${skipped.lastError ?? "no reason recorded"}.`,
        );
      }
    } catch (err) {
      // The claim stands; the write is still pending and the retry step picks it up.
      console.error("could not start a status", { status: status.id, err });
    }
  }
  return started;
}

/** Tries writes again that failed, or that were left pending by a run that stopped half way. */
async function retryDue(deps: TickDeps, scope: TickScope, limit: number): Promise<number> {
  const due = await deps.db
    .select({
      target: schema.statusTargets,
      status: schema.statuses,
      person: schema.people,
      botTokenSealed: schema.workspaces.botTokenSealed,
    })
    .from(schema.statusTargets)
    .innerJoin(schema.statuses, eq(schema.statusTargets.statusId, schema.statuses.id))
    .innerJoin(schema.people, eq(schema.statuses.personId, schema.people.id))
    .innerJoin(schema.workspaces, eq(schema.statuses.workspaceId, schema.workspaces.id))
    .where(
      and(
        inArray(schema.statusTargets.state, ["pending", "failed"]),
        lte(schema.statusTargets.nextAttemptAt, deps.now()),
        eq(schema.statuses.state, "active"),
        inScope(scope),
      ),
    )
    .orderBy(asc(schema.statusTargets.nextAttemptAt))
    .limit(limit);
  let retried = 0;
  for (const { target, status, person, botTokenSealed } of due) {
    try {
      const [after] = await retryTargets(
        deps.db,
        registryFor(deps),
        {
          workspaceId: person.workspaceId,
          personId: person.id,
          userToken: await userTokenOf(deps, person),
        },
        [target],
        deps.now,
      );
      retried++;
      if (after?.state === "failed" && after.attempts >= MAX_ATTEMPTS) {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Steward tried six times to set your Slack status for ${describeStatus(status, person.tz)} and it didn't go through (${after.lastError ?? "unknown error"}). Set it by hand in Slack, or run /ooo again.`,
        );
      } else if (after?.state === "skipped") {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Steward couldn't set your Slack status for ${describeStatus(status, person.tz)}: ${after.lastError ?? "no reason recorded"}.`,
        );
      }
    } catch (err) {
      console.error("could not retry a write", { target: target.id, err });
    }
  }
  return retried;
}

/** The status steps for one scope, in the order that matters: ends first, so nothing that is over is started. */
export async function runStatusSteps(
  deps: TickDeps,
  scope: TickScope,
  limits: TickLimits = TICK_LIMITS,
): Promise<StatusSteps> {
  const scheduledEnded = await endPassed(deps, scope, "scheduled");
  const ended = await endPassed(deps, scope, "active");
  const started = await startDue(deps, scope, limits.starts);
  const retried = await retryDue(deps, scope, limits.retries);
  return { scheduledEnded, ended, started, retried };
}

/** Runs once a minute from the cron trigger. Demo workspaces are left to their own sessions' clocks. */
export async function runTick(
  deps: TickDeps,
): Promise<StatusSteps & { undoWindowsExpired: number; demoSessionsRemoved: number }> {
  const undoWindowsExpired = await expireUndoWindows(deps);
  const steps = await runStatusSteps(deps, {});
  return { undoWindowsExpired, ...steps, demoSessionsRemoved: await cleanupDemoSessions(deps) };
}
```

Notes for the implementer:
- The raw SQL inside the claim uses the table and column names from `packages/core/src/db/schema.ts` (`statuses`, `person_id`, `state`). Check the table name there; if it differs, use the schema's.
- The last argument of `executeTargets` and `retryTargets` is whatever Task 1 defined (a clock function or a number). Pass what their signatures ask for.
- If `STATUS_LABEL`, `StatusType` or `formatRange` is not yet exported from `@steward/availability`, export it from `packages/availability/src/index.ts`.
- `apps/worker/src/index.ts` already passes the full `Deps` to `runTick`; it needs no change.
- `MAX_ATTEMPTS` is 6 and the message says "six times". If one changes, change both.
- A status with a failed write that then started retries only while the status is `active`; that is intended.

- [ ] **Step 4: Run the tick tests**

Run: `pnpm --filter @steward/worker exec vitest run test/tick.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Hold the budget on the real D1 driver**

In `apps/worker/test/demo.d1.smoke.test.ts`:

The cleanup test's tick now runs five more statements when nothing is due (two ends, two finds, and the one undo statement it already had stays), and it ends `S_REAL` (scheduled, its days passed) without starting it. After `expect(result.demoSessionsRemoved).toBe(5);` replace the old bound `expect(queries).toBeLessThanOrEqual(16);` with:

```ts
    expect(result).toMatchObject({ started: 0, retried: 0 });
    expect(queries).toBeLessThanOrEqual(21);
```

The surviving-ids assertion stays as it is: ending a status deletes nothing.

Add `seal` to the import from `@steward/core`, and add this test at the end of the `describe`:

```ts
  it("a full minute (three starts, two retries) stays under D1 Free's 50 statements", async () => {
    await upsertWorkspace(deps.db, {
      id: "T_FULL",
      name: "Full",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-full"),
      botUserId: "UB",
      installedAt: 1,
    });
    const at = deps.clock.now;
    const status = (id: string, personId: string, state: string) => ({
      id,
      workspaceId: "T_FULL",
      personId,
      type: "out",
      startMs: at - 1000,
      endMs: at + 86_400_000,
      text: "Out of office",
      emoji: ":palm_tree:",
      state,
      source: "form",
      createdAt: at - 2000,
      undoUntilMs: null,
      replacedStatusId: null,
    });
    const target = (statusId: string, state: string, attempts: number) => ({
      id: `G_${statusId}`,
      statusId,
      system: "slack-status",
      op: "set",
      spec: "{}",
      state,
      externalId: null,
      attempts,
      lastError: null,
      idempotencyKey: `${statusId}:slack-status:set`,
      nextAttemptAt: at - 1,
    });
    // Nobody here has connected Slack, so every write is skipped and every one sends a message:
    // the same number of statements as a write that works.
    for (const n of [1, 2, 3, 4, 5]) {
      const person = await ensurePerson(deps.db, "T_FULL", `U_F${n}`, `F${n}`);
      const starting = n <= 3;
      await deps.db
        .insert(schema.statuses)
        .values(status(`S_F${n}`, person.id, starting ? "scheduled" : "active"));
      await deps.db
        .insert(schema.statusTargets)
        .values(target(`S_F${n}`, starting ? "pending" : "failed", starting ? 0 : 5));
    }
    queries = 0;
    const result = await runTick(deps);
    expect(result).toMatchObject({ started: 3, retried: 2 });
    expect(queries).toBeLessThanOrEqual(45);
  }, 60_000);
```

Shape the two row builders after the columns in `packages/core/src/db/schema.ts` (`statuses`, `statusTargets`) and after how this file already inserts statuses: add any column the schema requires and drop any it does not have. If `upsertWorkspace`'s row has other fields, copy them from the existing workspace seed in this file.

Run: `pnpm --filter @steward/worker exec vitest run test/demo.d1.smoke.test.ts`
Expected: PASS. If either bound fails, do not raise it: print `queries`, find the statement the table above does not count, and report it. The limit of 50 is the platform's, and 45 is this plan's margin.

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/tick.ts apps/worker/test/tick.test.ts apps/worker/test/demo.d1.smoke.test.ts packages/availability/src/index.ts
git commit -m "feat(worker): the tick starts due statuses, ends finished ones and retries failed writes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `/ooo` shows what is scheduled, and the demo clock starts it

**Files:**
- Modify: `apps/worker/src/slack/handlers.ts` (`handleSlashCommand`)
- Modify: `apps/worker/src/routes/demo.ts:242-245` (`/advance`)
- Test: `apps/worker/test/ooo.test.ts`, `apps/worker/test/demo.test.ts`

**Interfaces:**
- Consumes: `scheduledStatusesFor(db, personId, limit)` and `resultCard` (Task 3); `runStatusSteps(deps, scope, limits)`, `DEMO_TICK_LIMITS` (Task 4); `demoDeps`, `demoWorkspaceId` from `apps/worker/src/demo/session.ts`; `targetsForStatus` from `@steward/core`.
- Produces: `SCHEDULED_SHOWN = 3` (handlers.ts). After `/ooo` opens the form, Steward sends one card per scheduled status (at most three, earliest first) to the command's `response_url`; each is the ordinary receipt card, so its Cancel button works with the existing handler and replaces only its own card.

Why three: Slack accepts five messages on one `response_url`.

- [ ] **Step 1: Write the failing tests**

In `apps/worker/test/ooo.test.ts`, add the two tests below. For the `/ooo` post, copy the form fields from the existing test that opens the form (around line 59) and make sure `response_url: RESPONSE_URL` is among them:

```ts
  it("/ooo also shows the statuses that are scheduled, each with its own Cancel", async () => {
    await seedWorkspace(deps);
    for (const day of ["2026-11-20", "2026-11-13"]) {
      await slackPost(app, "/slack/interactions", {
        payload: JSON.stringify(submission({ type: "out", from: day, to: day })),
      });
      await flush(deps);
    }
    deps.slack.responses.length = 0;

    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "trig-2",
      response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(2);
    expect(deps.slack.responses[0]?.text).toMatch(/^Scheduled · Out of office · /);
    expect(deps.slack.responses[1]?.text).toMatch(/^Scheduled · Out of office · /);
    // Earliest first: the two cards are for different statuses, the 13th before the 20th.
    const [first, second] = deps.slack.responses.map((r) => undoValue(r.blocks ?? []));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const rows = await deps.db.select().from(schema.statuses);
    const startOf = (id: string | undefined) => rows.find((r) => r.id === id)?.startMs ?? 0;
    expect(startOf(first)).toBeLessThan(startOf(second));
  });

  it("/ooo sends nothing extra when nothing is scheduled", async () => {
    await seedWorkspace(deps);
    await slackPost(app, "/slack/commands", {
      command: "/ooo",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "trig-3",
      response_url: RESPONSE_URL,
    });
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(0);
  });
```

In `apps/worker/test/demo.test.ts`, add `nextDay` to the import from `@steward/availability` (if the package has no such helper, compute tomorrow as `new Date(NOW + 86_400_000).toISOString().slice(0, 10)`) and add:

```ts
  it("moving the demo clock past the first day starts a scheduled status", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const tomorrow = nextDay(todayIn("UTC", NOW));
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${s.id}/interact`, submission(tomorrow, tomorrow));
    let state = await getState(app, s.id);
    expect(JSON.stringify(state.events.at(-1)?.payload)).toContain("Scheduled · ");
    expect(state.events.some((e) => e.kind === "status")).toBe(false);

    const advanced = await post(app, `/demo/${s.id}/advance`, { minutes: 1440 });
    expect(advanced.status).toBe(200);
    state = await getState(app, s.id);
    const set = state.events.filter((e) => e.kind === "status");
    expect(set).toHaveLength(1);
    expect(JSON.stringify(set[0]?.payload)).toContain("Out of office");
  });
```

If the existing demo tests name the status event differently from `"status"`, use their name.

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @steward/worker exec vitest run test/ooo.test.ts test/demo.test.ts`
Expected: FAIL. `/ooo` sends no cards, and no status event appears after the clock moves.

- [ ] **Step 3: Show the scheduled statuses after `/ooo`**

In `apps/worker/src/slack/handlers.ts`, add `scheduledStatusesFor` to the import from `@steward/availability` and `targetsForStatus` (and the `PersonRow` type, if not yet imported) to the import from `@steward/core`. Above `handleSlashCommand` add:

```ts
/** How many scheduled statuses /ooo shows. Slack takes five messages on one response_url. */
export const SCHEDULED_SHOWN = 3;

/** One card per status that has not started yet, each with its own Cancel. Never throws: the form is already open. */
async function showScheduled(deps: Deps, person: PersonRow, responseUrl: string): Promise<void> {
  try {
    const scheduled = await scheduledStatusesFor(deps.db, person.id, SCHEDULED_SHOWN);
    for (const status of scheduled) {
      const card = resultCard({
        status,
        targets: await targetsForStatus(deps.db, status.id),
        tz: person.tz,
        now: deps.now(),
      });
      await deps.slack.respond({ responseUrl, ...card });
    }
  } catch (err) {
    console.error("could not show scheduled statuses", { person: person.id, err });
  }
}
```

In `handleSlashCommand`, directly after the `await deps.slack.openView({ … });` call succeeds, add (reading `response_url` the same way the function reads its other form fields):

```ts
    const responseUrl = form.get("response_url") ?? "";
    if (responseUrl) deps.defer(showScheduled(deps, person, responseUrl));
```

If an existing test asserts that nothing is deferred right after a `/ooo` command, replace that assertion with `await flush(deps); expect(deps.slack.responses).toHaveLength(0);`: the deferred work now exists and sends nothing.

- [ ] **Step 4: Run the session's status steps when the demo clock moves**

In `apps/worker/src/routes/demo.ts`, add `demoWorkspaceId` (and `demoDeps`, if not yet imported) to the import from `../demo/session`, add `import { DEMO_TICK_LIMITS, runStatusSteps } from "../tick";`, and replace the last line of the `/advance` handler (`return c.json(await stateOf(deps, advanced));`) with:

```ts
    // The every-minute tick leaves demo workspaces alone: a session's statuses start, end and retry
    // by its own clock, at the moment the visitor moves it.
    const d = demoDeps(deps, advanced);
    try {
      await runStatusSteps(d, { workspaceId: demoWorkspaceId(advanced.id) }, DEMO_TICK_LIMITS);
    } catch (err) {
      console.error("demo status steps failed", { session: advanced.id, err });
    }
    await d.settle();
    return c.json(await stateOf(deps, advanced));
```

- [ ] **Step 5: Hold the demo request's budget**

In `apps/worker/test/demo.d1.smoke.test.ts`, find the test that counts the statements of a demo request (it resets `queries = 0` before a `/demo/…` call). Add, in the same style, a case that schedules a status for tomorrow in a session, resets `queries = 0`, posts `/advance` with `{ minutes: 1440 }`, and expects `queries` to be at most 45. If the file counts no demo request yet, add the case next to the cleanup test using its app and counter.

- [ ] **Step 6: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, including `apps/worker/test/webContract.test.ts` unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/slack/handlers.ts apps/worker/src/routes/demo.ts apps/worker/test
git commit -m "feat(worker): /ooo shows scheduled statuses with Cancel; the demo clock starts them

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: The pages and the README say what is true now

**Files:**
- Modify: `apps/web/src/pages/Product.tsx` (`WORKS_TODAY`, `COMING_NEXT`)
- Modify: `apps/web/src/demo/Emulator.tsx:207`
- Modify: `README.md:7` and its Deploy section
- Modify: comments that name "Plan 3" in `packages/availability/src/status/plan.ts`, `service.ts`, `form.ts` and `apps/worker/src/tick.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing other tasks use.

- [ ] **Step 1: Find tests that quote the old sentences**

Run: `grep -rn "Dates in the future\|undo window close and the status expire" apps packages --include=*.ts --include=*.tsx`
Expected: only `Product.tsx` and `Emulator.tsx`. If a test quotes either sentence, update it in the same step as the sentence.

- [ ] **Step 2: Change the product page**

In `apps/web/src/pages/Product.tsx`: in `WORKS_TODAY`, add these two entries directly after the entry about the receipt and its Undo button, and leave the other entries as they are:

```ts
  "Pick a first day in the future and Steward sets the status when that day begins. Until then you can cancel it.",
  "If Slack refuses a change, Steward tries again for about half an hour, then tells you.",
```

In `COMING_NEXT`, replace the entry `"Dates in the future, and requests in plain words."` with:

```ts
  "Google Calendar out-of-office and the Gmail auto-reply, set and undone together with the status.",
  "Requests in plain words.",
```

If `COMING_NEXT` already has an entry about Google Calendar or Gmail, keep that one and add only `"Requests in plain words."`.

- [ ] **Step 3: Change the emulator's hint**

In `apps/web/src/demo/Emulator.tsx`, replace `Move time forward to watch the undo window close and the status expire.` with `Move time forward to watch the undo window close, a scheduled status start, and a status expire.`

- [ ] **Step 4: Change the README**

In `README.md` line 7, replace the sentence `Only the Slack status works today.` with `Today it sets the Slack status, at once or from a first day in the future.`

In the Deploy section, after the last numbered step, add:

```markdown
**After a change that adds a migration** (a new file in `packages/core/drizzle/`): CI applies it before it deploys. When you deploy by hand, run `pnpm --filter @steward/worker db:migrate:remote` first, then deploy; the new code expects the new columns.
```

- [ ] **Step 5: Reword the comments that name a plan**

Run `grep -rn "Plan 3" apps packages --include=*.ts --include=*.tsx`. Reword each comment it prints to say what the code does, without naming a plan (for `plan.ts:6`: "Calendar and Gmail are added as further specs here"). Run it again and expect no output.

- [ ] **Step 6: Run everything and build the pages**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @steward/web build`
Expected: PASS, and the build finishes without errors.

- [ ] **Step 7: Commit**

```bash
git add apps packages README.md
git commit -m "docs: the pages and the README describe scheduling, Cancel and retries

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Do not push and do not open a pull request; the controller does both after the final review.

---

## After the last task

1. The controller runs the final review over the whole branch, pushes it and opens the pull request.
2. Merging waits for the owner's word for that pull request.
3. After the merge, by hand and never from a subagent: apply migration `0006` to the live database (`pnpm --filter @steward/worker db:migrate:remote`), deploy, then check in the Steward Lab workspace: save a status for tomorrow, see "Scheduled" and Cancel, run `/ooo` again and see the card, cancel it.

## Not in this plan

| Left out | Where it goes |
|---|---|
| Google sign-in, the Calendar out-of-office event, the Gmail auto-reply | Plan 3b. Needs the owner's Google Cloud OAuth client (free). |
| Requests in plain words | Plan 3c. Needs an Anthropic key; that costs money, so the owner decides first. |
| Weekly rules ("remote every Friday"), asking before a planned status starts, "Set the previous one again" | A later plan; none is needed for 3b or 3c. |
| Restoring the earlier status when the one that replaced it ends or is undone | Not planned. The receipt names what was replaced. |
| Changing the dates of a scheduled status | Cancel it and save a new one. |
