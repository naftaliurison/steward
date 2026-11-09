import { schema } from "@steward/core";
import { and, isNotNull, lt } from "drizzle-orm";
import { cleanupDemoSessions } from "./demo/session";
import type { Deps } from "./deps";

/** Undo windows that have passed are closed so the card stops offering Undo. One statement, whatever the number. */
export async function expireUndoWindows(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const closed = await deps.db
    .update(schema.statuses)
    .set({ undoUntilMs: null })
    .where(and(isNotNull(schema.statuses.undoUntilMs), lt(schema.statuses.undoUntilMs, deps.now())))
    .returning({ id: schema.statuses.id });
  return closed.length;
}

/** Runs once a minute from the cron trigger. Plan 3 adds scheduled fires, asks and retries here. */
export async function runTick(
  deps: Pick<Deps, "db" | "now">,
): Promise<{ undoWindowsExpired: number; demoSessionsRemoved: number }> {
  return {
    undoWindowsExpired: await expireUndoWindows(deps),
    demoSessionsRemoved: await cleanupDemoSessions(deps),
  };
}
