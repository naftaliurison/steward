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
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
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
 * The count assumes one target per status. A retry is 3 statements: the claim, the update and the
 * audit row (the outcome comes back from the engine, so there is no re-read).
 */
/** A retry is claimed for this long; if the tick dies after claiming, the target is due again when it ends. */
const RETRY_LEASE_MS = 5 * 60_000;

export const TICK_LIMITS: TickLimits = { starts: 3, retries: 2 };
/** A demo request also claims an action, moves the clock and reads its state, so it does less. */
export const DEMO_TICK_LIMITS: TickLimits = { starts: 2, retries: 1 };

const inScope = (scope: TickScope) =>
  scope.workspaceId
    ? eq(schema.statuses.workspaceId, scope.workspaceId)
    : sql`substr(${schema.statuses.workspaceId}, 1, 5) <> 'demo:'`;

const registryFor = (deps: TickDeps) =>
  new ConnectorRegistry().register(new SlackStatusConnector(deps.slack));

const labelOf = (status: StatusRow): string =>
  STATUS_LABEL[status.type as StatusType] ?? status.type;
const rangeOf = (status: StatusRow, tz: string): string =>
  formatRange(status.startMs, status.endMs, tz);
const describeStatus = (status: StatusRow, tz: string): string =>
  `${labelOf(status)} (${rangeOf(status, tz)})`;

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
          `Your ${labelOf(status)} status (${rangeOf(status, person.tz)}) started, but Steward couldn't set your Slack status: ${skipped.lastError ?? "no reason recorded"}.`,
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
      // Claim it: one update, so two overlapping ticks cannot both write it. It leaves state and
      // attempts alone (the engine's own guard reads them) and moves the retry time out by the lease;
      // recording the result sets the real next time.
      const claimed = await deps.db
        .update(schema.statusTargets)
        .set({ nextAttemptAt: deps.now() + RETRY_LEASE_MS })
        .where(
          and(
            eq(schema.statusTargets.id, target.id),
            eq(schema.statusTargets.state, target.state),
            eq(schema.statusTargets.attempts, target.attempts),
            target.nextAttemptAt === null
              ? isNull(schema.statusTargets.nextAttemptAt)
              : eq(schema.statusTargets.nextAttemptAt, target.nextAttemptAt),
          ),
        )
        .returning({ id: schema.statusTargets.id });
      if (claimed.length === 0) continue;
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
      if (!after?.ran) continue;
      retried++;
      // Only the tick whose result was recorded tells the person.
      if (!after.won) continue;
      if (after.state === "failed" && after.attempts >= MAX_ATTEMPTS) {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Steward tried six times to set your Slack status for ${describeStatus(status, person.tz)} and it didn't go through (${after.lastError ?? "unknown error"}). Set it by hand in Slack, or run /ooo again.`,
        );
      } else if (after.state === "skipped") {
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
