import { schema } from "@steward/core";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { cleanupDemoSessions } from "./demo/session";
import type { Deps } from "./deps";

/** Undo windows that have passed are closed so the card stops offering Undo. */
export async function expireUndoWindows(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const now = deps.now();
  const due = await deps.db
    .select({ id: schema.statuses.id })
    .from(schema.statuses)
    .where(and(isNotNull(schema.statuses.undoUntilMs), lt(schema.statuses.undoUntilMs, now)));
  for (const row of due) {
    await deps.db
      .update(schema.statuses)
      .set({ undoUntilMs: null })
      .where(eq(schema.statuses.id, row.id));
  }
  return due.length;
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
