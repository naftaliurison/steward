import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { audit, statuses } from "../db/schema";
import { createTestDb } from "../testing";
import {
  type ActorCtx,
  type Connector,
  type ConnectorCtx,
  ConnectorRegistry,
  SkipWrite,
  type WriteSpec,
} from "./connector";
import { createTargets, executeTargets, targetsForStatus, undoTargets } from "./engine";

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
    const [done, failed, pending] = await executeTargets(
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
});
