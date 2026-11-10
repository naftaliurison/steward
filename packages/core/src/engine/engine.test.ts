import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { audit, statuses, statusTargets } from "../db/schema";
import { createTestDb } from "../testing";
import {
  type ActorCtx,
  type Connector,
  type ConnectorCtx,
  ConnectorRegistry,
  SkipWrite,
  type WriteSpec,
} from "./connector";
import {
  createTargets,
  executeTargets,
  MAX_ATTEMPTS,
  nextAttemptAfter,
  retryTargets,
  targetsForStatus,
  undoTargets,
} from "./engine";

class RecordingConnector implements Connector {
  performed: WriteSpec[] = [];
  undone: string[] = [];
  keysSeen: { op: "perform" | "undo"; key: string }[] = [];
  constructor(
    readonly system: string,
    private readonly behaviour: "ok" | "fail" | "skip" | "undoFails" = "ok",
  ) {}
  async perform(spec: WriteSpec, ctx: ConnectorCtx): Promise<{ externalId: string }> {
    this.keysSeen.push({ op: "perform", key: ctx.idempotencyKey });
    if (this.behaviour === "fail") throw new Error("rate limited by the other side");
    if (this.behaviour === "skip") throw new SkipWrite("not connected yet");
    this.performed.push(spec);
    return { externalId: `ext-${this.performed.length}` };
  }
  async undo(externalId: string, _spec: WriteSpec, ctx: ConnectorCtx): Promise<void> {
    this.keysSeen.push({ op: "undo", key: ctx.idempotencyKey });
    if (this.behaviour === "undoFails") throw new Error("remote said no");
    this.undone.push(externalId);
  }
}

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

const ctx: ActorCtx = { workspaceId: "T1", personId: "T1:U1", userToken: "xoxp" };
const now = () => 1_700_000_000_000;

describe("engine", () => {
  let db: Db;
  beforeEach(async () => {
    db = createTestDb();
    await db.insert(statuses).values({
      id: "S1",
      workspaceId: "T1",
      personId: "T1:U1",
      type: "out",
      startMs: 1,
      endMs: 2,
      text: "Out",
      emoji: ":x:",
      state: "active",
      source: "form",
      createdAt: 0,
      undoUntilMs: null,
      replacedStatusId: null,
    });
  });

  it("creates pending targets with idempotency keys", async () => {
    const targets = await createTargets(db, "S1", [
      { system: "a", op: "set", args: { v: 1 } },
      { system: "b", op: "set", args: {} },
    ]);
    expect(targets.map((t) => t.state)).toEqual(["pending", "pending"]);
    expect(targets.map((t) => t.idempotencyKey)).toEqual(["S1:a:set", "S1:b:set"]);
    expect(await targetsForStatus(db, "S1")).toHaveLength(2);
  });

  it("takes the recovery time from a function, once per spec", async () => {
    const seen: string[] = [];
    const targets = await createTargets(
      db,
      "S1",
      [
        { system: "a", op: "set", args: {} },
        { system: "b", op: "set", args: {} },
        { system: "c", op: "set", args: {} },
      ],
      (spec) => {
        seen.push(spec.system);
        return spec.system === "a" ? 100 : spec.system === "b" ? null : 300;
      },
    );
    expect(seen).toEqual(["a", "b", "c"]);
    expect(targets.map((t) => t.nextAttemptAt)).toEqual([100, null, 300]);
    expect((await targetsForStatus(db, "S1")).map((t) => t.nextAttemptAt)).toEqual([
      100,
      null,
      300,
    ]);
  });

  it("runs each target independently and records honest states", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry()
      .register(a)
      .register(new RecordingConnector("b", "fail"))
      .register(new RecordingConnector("c", "skip"));
    const created = await createTargets(db, "S1", [
      { system: "a", op: "set", args: { v: 1 } },
      { system: "b", op: "set", args: {} },
      { system: "c", op: "set", args: {} },
      { system: "d", op: "set", args: {} },
    ]);
    const result = await executeTargets(db, registry, ctx, created, now);
    const byState = Object.fromEntries(
      result.map((t) => [t.system, [t.state, t.lastError, t.externalId]]),
    );
    expect(byState).toEqual({
      a: ["done", null, "ext-1"],
      b: ["failed", "rate limited by the other side", null],
      c: ["skipped", "not connected yet", null],
      d: ["skipped", "no connector for d", null],
    });
    expect(a.performed).toEqual([{ system: "a", op: "set", args: { v: 1 } }]);
    const auditRows = await db.select().from(audit).where(eq(audit.workspaceId, "T1"));
    expect(auditRows.map((r) => `${r.action}:${r.result}`).sort()).toEqual(
      ["a.set:done", "b.set:failed", "c.set:skipped", "d.set:skipped"].sort(),
    );
  });

  it("undo reverses done targets, retires pending ones and leaves failed ones alone", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry()
      .register(a)
      .register(new RecordingConnector("b", "fail"));
    const created = await createTargets(db, "S1", [
      { system: "a", op: "set", args: {} },
      { system: "b", op: "set", args: {} },
      { system: "a", op: "later", args: {} },
    ]);
    const [pending, done, failed] = await executeTargets(
      db,
      registry,
      ctx,
      created.slice(0, 2),
      now,
    ).then(async () => targetsForStatus(db, "S1"));
    expect([done?.state, failed?.state, pending?.state]).toEqual(["done", "failed", "pending"]);
    const after = await undoTargets(db, registry, ctx, await targetsForStatus(db, "S1"), now);
    const states = Object.fromEntries(after.map((t) => [`${t.system}.${t.op}`, t.state]));
    expect(states).toEqual({ "a.set": "undone", "b.set": "failed", "a.later": "undone" });
    expect(a.undone).toEqual(["ext-1"]);
  });

  it("does not re-run a target that is no longer pending", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const once = await executeTargets(db, registry, ctx, created, now);
    await executeTargets(db, registry, ctx, once, now);
    expect(a.performed).toHaveLength(1);
  });

  it("hands connectors the target's idempotency key on perform and undo", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const done = await executeTargets(db, registry, ctx, created, now);
    await undoTargets(db, registry, ctx, done, now);
    expect(a.keysSeen).toEqual([
      { op: "perform", key: "S1:a:set" },
      { op: "undo", key: "S1:a:set" },
    ]);
  });

  it("keeps a target done and audits undo_failed when the connector's undo throws", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a", "undoFails"));
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const done = await executeTargets(db, registry, ctx, created, now);
    const [after] = await undoTargets(db, registry, ctx, done, now);
    expect(after?.state).toBe("done");
    expect(after?.lastError?.startsWith("undo didn't go through — remote said no")).toBe(true);
    const rows = await db.select().from(audit).where(eq(audit.action, "a.set.undo"));
    expect(rows.map((r) => r.result)).toEqual(["undo_failed"]);
  });

  it("keeps a target done and audits undo_failed when no connector is registered for undo", async () => {
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const done = await executeTargets(
      db,
      new ConnectorRegistry().register(new RecordingConnector("a")),
      ctx,
      created,
      now,
    );
    const [after] = await undoTargets(db, new ConnectorRegistry(), ctx, done, now);
    expect(after?.state).toBe("done");
    expect(after?.lastError).toContain("no connector");
    const rows = await db.select().from(audit).where(eq(audit.action, "a.set.undo"));
    expect(rows.map((r) => r.result)).toEqual(["undo_failed"]);
  });

  it("counts attempts: 1 after execute, 2 after undo", async () => {
    const registry = new ConnectorRegistry().register(new RecordingConnector("a"));
    const created = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    const done = await executeTargets(db, registry, ctx, created, now);
    expect(done[0]?.attempts).toBe(1);
    const undone = await undoTargets(db, registry, ctx, done, now);
    expect(undone[0]?.attempts).toBe(2);
  });

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
    expect((await retryTargets(db, registry, ctx, rows, now))[0]).toMatchObject({
      won: true,
      state: "failed",
      attempts: 2,
      nextAttemptAt: now() + 120_000,
    });
    rows = await targetsForStatus(db, "S1");
    expect((await retryTargets(db, registry, ctx, rows, now))[0]).toMatchObject({ won: true });
    rows = await targetsForStatus(db, "S1");
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
    for (let i = 0; i < 5; i++) {
      await retryTargets(db, registry, ctx, rows, now);
      rows = await targetsForStatus(db, "S1");
    }
    expect(rows[0]).toMatchObject({ state: "failed", attempts: 6, nextAttemptAt: null });
  });

  it("retry also runs a target that was left pending", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const rows = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }], 1);
    const [done] = await retryTargets(db, registry, ctx, rows, now);
    expect(done).toMatchObject({ ran: true, won: true, state: "done", attempts: 1 });
    expect(a.performed).toHaveLength(1);
  });

  it("retry does not run a target that has used all its tries, whatever the caller filtered", async () => {
    const a = new RecordingConnector("a", "fail");
    const registry = new ConnectorRegistry().register(a);
    const [created] = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }]);
    if (!created) throw new Error("no target");
    const spent = { ...created, state: "failed", attempts: MAX_ATTEMPTS, lastError: "old" };
    const [outcome] = await retryTargets(db, registry, ctx, [spent], now);
    expect(outcome).toMatchObject({
      ran: false,
      won: false,
      state: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "old",
    });
    expect(a.keysSeen).toHaveLength(0);
  });

  it("retry says it lost when the row changed underneath it, and reports the state it read", async () => {
    const a = new RecordingConnector("a");
    const registry = new ConnectorRegistry().register(a);
    const stale = await createTargets(db, "S1", [{ system: "a", op: "set", args: {} }], 1);
    await db
      .update(statusTargets)
      .set({ attempts: 1, state: "failed" })
      .where(eq(statusTargets.statusId, "S1"));
    const [outcome] = await retryTargets(db, registry, ctx, stale, now);
    expect(outcome).toMatchObject({ ran: true, won: false, state: "pending", attempts: 0 });
    expect(await db.select().from(audit)).toHaveLength(0);
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
});
