import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { audit, statusTargets, type TargetRow } from "../db/schema";
import { newId } from "../ids";
import { type ConnectorCtx, type ConnectorRegistry, SkipWrite, type WriteSpec } from "./connector";

export type TargetState = "pending" | "done" | "failed" | "skipped" | "undone";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function targetsById(db: Db, ids: string[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(statusTargets).where(inArray(statusTargets.id, ids));
}

export async function targetsForStatus(db: Db, statusId: string): Promise<TargetRow[]> {
  return db.select().from(statusTargets).where(eq(statusTargets.statusId, statusId));
}

/** One pending row per write. The idempotency key is stable across retries of the same status. */
export async function createTargets(
  db: Db,
  statusId: string,
  specs: WriteSpec[],
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
    idempotencyKey: `${statusId}:${spec.system}:${spec.op}`,
  }));
  if (rows.length > 0) await db.insert(statusTargets).values(rows);
  return rows;
}

type Patch = { state: TargetState; externalId?: string | null; lastError: string | null };

async function record(
  db: Db,
  ctx: ConnectorCtx,
  target: TargetRow,
  action: string,
  patch: Patch,
  at: number,
): Promise<void> {
  await db
    .update(statusTargets)
    .set({ ...patch, attempts: target.attempts + 1 })
    .where(eq(statusTargets.id, target.id));
  await db.insert(audit).values({
    id: newId(),
    workspaceId: ctx.workspaceId,
    personId: ctx.personId,
    action,
    result: patch.state,
    detail: patch.lastError,
    at,
    idempotencyKey: target.idempotencyKey,
  });
}

/** Runs every pending target independently; one failure never blocks another. */
export async function executeTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ConnectorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<TargetRow[]> {
  for (const target of targets) {
    if (target.state !== "pending") continue;
    const spec = JSON.parse(target.spec) as WriteSpec;
    const connector = registry.get(target.system);
    let patch: Patch;
    if (!connector) {
      patch = { state: "skipped", lastError: `no connector for ${target.system}` };
    } else {
      try {
        const { externalId } = await connector.perform(spec, ctx);
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

/** Reverses done targets through their connector; pending ones simply become undone; failed ones stay failed. */
export async function undoTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ConnectorCtx,
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
    if (!connector) {
      patch = { state: "done", lastError: `no connector for ${target.system}; could not undo` };
    } else {
      try {
        await connector.undo(target.externalId ?? "", spec, ctx);
        patch = { state: "undone", lastError: null };
      } catch (err) {
        patch = { state: "done", lastError: `undo didn't go through — ${errorMessage(err)}` };
      }
    }
    await record(db, ctx, target, action, patch, now());
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}
