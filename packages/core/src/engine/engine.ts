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
 * should have run it never finished). It may be a function of the spec, called once per spec.
 */
export async function createTargets(
  db: Db,
  statusId: string,
  specs: WriteSpec[],
  recoverAt: number | null | ((spec: WriteSpec) => number | null) = null,
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
    nextAttemptAt: typeof recoverAt === "function" ? recoverAt(spec) : recoverAt,
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

/** Performs one target's write through its connector and says what to record. Never throws. */
async function perform(
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  target: TargetRow,
): Promise<Patch> {
  const spec = JSON.parse(target.spec) as WriteSpec;
  const connector = registry.get(target.system);
  if (!connector) return { state: "skipped", lastError: `no connector for ${target.system}` };
  try {
    const { externalId } = await connector.perform(spec, {
      ...ctx,
      idempotencyKey: target.idempotencyKey,
    });
    return { state: "done", externalId, lastError: null };
  } catch (err) {
    return err instanceof SkipWrite
      ? { state: "skipped", lastError: err.reason }
      : { state: "failed", lastError: errorMessage(err) };
  }
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
    const patch = await perform(registry, ctx, target);
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

/** What happened to one target in `retryTargets`. */
export type RetryOutcome = {
  id: string;
  /** False when the target was left alone (not pending or failed, or out of tries): nothing was written. */
  ran: boolean;
  /** True only if this call's result was recorded; false if the row changed underneath it or it did not run. */
  won: boolean;
  /** The target's state, attempts and last error after this call (as they were read if it did not win). */
  state: string;
  attempts: number;
  lastError: string | null;
  externalId: string | null;
  nextAttemptAt: number | null;
};

/**
 * Tries failed targets again, and runs targets that were left pending. Done, skipped and undone
 * ones are left alone, and so is one that has used all its tries. Says per target whether its
 * result was recorded; a caller that must act once (like telling the person) acts only on a win.
 */
export async function retryTargets(
  db: Db,
  registry: ConnectorRegistry,
  ctx: ActorCtx,
  targets: TargetRow[],
  now: () => number,
): Promise<RetryOutcome[]> {
  const outcomes: RetryOutcome[] = [];
  for (const target of targets) {
    const unchanged = (ran: boolean): RetryOutcome => ({
      id: target.id,
      ran,
      won: false,
      state: target.state,
      attempts: target.attempts,
      lastError: target.lastError,
      externalId: target.externalId,
      nextAttemptAt: target.nextAttemptAt,
    });
    if (
      (target.state !== "pending" && target.state !== "failed") ||
      target.attempts >= MAX_ATTEMPTS
    ) {
      outcomes.push(unchanged(false));
      continue;
    }
    const patch = await perform(registry, ctx, target);
    const at = now();
    const won = await record(db, ctx, target, `${target.system}.${target.op}`, patch, at);
    if (!won) {
      outcomes.push(unchanged(true));
      continue;
    }
    const attempts = target.attempts + 1;
    outcomes.push({
      id: target.id,
      ran: true,
      won: true,
      state: patch.state,
      attempts,
      lastError: patch.lastError,
      externalId: patch.externalId === undefined ? target.externalId : patch.externalId,
      nextAttemptAt: patch.state === "failed" ? nextAttemptAfter(attempts, at) : null,
    });
  }
  return outcomes;
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
        if (err instanceof SkipWrite) {
          // Nothing to reverse any more (Google was disconnected): the undo is done, and the reason says what was left.
          patch = { state: "undone", lastError: err.reason };
        } else {
          result = "undo_failed";
          patch = { state: "done", lastError: `undo didn't go through — ${errorMessage(err)}` };
        }
      }
    }
    await record(db, ctx, target, action, patch, now(), result);
  }
  return targetsById(
    db,
    targets.map((t) => t.id),
  );
}
