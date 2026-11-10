import {
  formatRange,
  GMAIL_RESPONDER,
  GOOGLE_CALENDAR,
  SLACK_STATUS,
  STATUS_LABEL,
  type StatusType,
  writesAtSave,
} from "@steward/availability";
import {
  executeTargets,
  MAX_ATTEMPTS,
  open,
  type PersonRow,
  retryTargets,
  type StatusRow,
  schema,
  targetsForStatus,
} from "@steward/core";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { cleanupDemoSessions } from "./demo/session";
import type { Deps } from "./deps";
import { registryFor } from "./registry";

export type TickDeps = Pick<
  Deps,
  "db" | "now" | "slack" | "tokenKey" | "google" | "googleClientId" | "googleClientSecret"
>;
/** Which statuses a run looks at: one workspace, or (with no id) every workspace that is not a demo. */
export type TickScope = { workspaceId?: string };
export type TickLimits = { starts: number; retries: number };
export type StatusSteps = {
  scheduledEnded: number;
  ended: number;
  started: number;
  retried: number;
};

/** A retry is claimed for this long; if the tick dies after claiming, the target is due again when it ends. */
const RETRY_LEASE_MS = 5 * 60_000;

/**
 * The most the every-minute tick does in one run. With these the worst case is 44 D1 statements and
 * 7 outbound calls (Slack and Google together); both free plans stop an invocation at 50. Raise them
 * only with that sum redone.
 *
 * The count, one target per status:
 * - the undo windows 1, the two ends 2, the demo cleanup at most 15: 18 statements, no calls;
 * - starts: 1 select, then per status the claim, the ending of the one it replaces, the read of its
 *   targets, the target's update and audit row and the engine's re-read: 6 statements, and 1 call (the
 *   Slack write, or the message when it was skipped). A start no longer touches Google. 3 starts:
 *   19 statements, 3 calls;
 * - retries: 1 select, then a budget of 2. A Slack retry is 3 statements (claim, update, audit row) and
 *   at worst 2 calls (the write, then the give-up message): 2 of them are 7 statements, 4 calls.
 *   A Google retry counts as two because it is worth two: the claim, the connection read, a token
 *   refresh (1 call, 1 statement), at most 2 calls to Google for the one chosen calendar (the main
 *   calendar's insert, then its all-day fallback) or for Gmail (read, then write), a 401 forgetting the
 *   token (1 statement), the update and the audit row (2), and the message (1 call): 6 statements,
 *   4 calls, plus the select: 7 and 4, the same as two Slack retries.
 * Total: 18 + 19 + 7 = 44 statements; 3 + 4 = 7 calls.
 * The sum assumes one chosen calendar per person (today only the main calendar can be chosen). With
 * more, one Google retry could make more calls: redo it before people can choose more calendars.
 * Cloudflare may count D1 statements and outbound calls against one limit of 50, so the number to watch
 * is statements plus calls (44 + 7 in the worst case); the last demo-cleanup deletes are the part
 * that would be cut and redone the next minute.
 */
export const TICK_LIMITS: TickLimits = { starts: 3, retries: 2 };
/** A demo request also claims an action, moves the clock and reads its state, so it does less. */
export const DEMO_TICK_LIMITS: TickLimits = { starts: 2, retries: 1 };

const inScope = (scope: TickScope) =>
  scope.workspaceId !== undefined
    ? eq(schema.statuses.workspaceId, scope.workspaceId)
    : sql`substr(${schema.statuses.workspaceId}, 1, 5) <> 'demo:'`;

/**
 * What a retry costs against `limits.retries`. A Slack write is one outbound call. A Google write is
 * two weights because it is more work: a token refresh, one or two calls to Google, and a possible
 * statement to forget a token Google refused (see the count above TICK_LIMITS).
 */
export function retryWeight(system: string): number {
  return system === SLACK_STATUS ? 1 : 2;
}

/** The words the person is told, per system: what Steward was doing, and what they can do by hand. */
const WRITE_WORDS: Record<string, { action: string; byHand: string }> = {
  [SLACK_STATUS]: { action: "set your Slack status", byHand: "Set it by hand in Slack" },
  [GOOGLE_CALENDAR]: { action: "add your calendar event", byHand: "Set it by hand" },
  [GMAIL_RESPONDER]: { action: "turn on your Gmail auto-reply", byHand: "Set it by hand" },
};
const wordsFor = (system: string) =>
  WRITE_WORDS[system] ?? { action: `write to ${system}`, byHand: "Set it by hand" };

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
      // The Google writes were made when the status was saved (or are retried below): not again here.
      const atStart = (await targetsForStatus(deps.db, status.id)).filter(
        (t) => !writesAtSave(t.system),
      );
      const targets =
        atStart.length === 0
          ? []
          : await executeTargets(
              deps.db,
              registryFor(deps),
              {
                workspaceId: person.workspaceId,
                personId: person.id,
                userToken: await userTokenOf(deps, person),
              },
              atStart,
              deps.now,
            );
      // A start is quiet when it works. A failed write is retried below; a skipped one never will be, so say so now.
      const skipped = targets.find((t) => t.system === SLACK_STATUS && t.state === "skipped");
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

/**
 * Tries writes again that failed, or that were left pending by a run that stopped half way: those of
 * an active status, and the Google writes of a scheduled one (they are made at save, not at start).
 * `limit` is a budget of weight (see `retryWeight`); the first due row always runs, and the run stops
 * at the first row that does not fit, which stays due and comes first next minute.
 */
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
        or(
          eq(schema.statuses.state, "active"),
          and(
            eq(schema.statuses.state, "scheduled"),
            inArray(schema.statusTargets.system, [GOOGLE_CALENDAR, GMAIL_RESPONDER]),
          ),
        ),
        inScope(scope),
      ),
    )
    .orderBy(asc(schema.statusTargets.nextAttemptAt))
    .limit(limit);
  let retried = 0;
  let weight = 0;
  for (const { target, status, person, botTokenSealed } of due) {
    const cost = retryWeight(target.system);
    if (weight > 0 && weight + cost > limit) break;
    weight += cost;
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
      const words = wordsFor(target.system);
      if (after.state === "failed" && after.attempts >= MAX_ATTEMPTS) {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Steward tried six times to ${words.action} for ${describeStatus(status, person.tz)} and it didn't go through. ${words.byHand}, or run /ooo again.`,
        );
      } else if (after.state === "skipped") {
        await tell(
          deps,
          botTokenSealed,
          person,
          `Steward couldn't ${words.action} for ${describeStatus(status, person.tz)}: ${after.lastError ?? "no reason recorded"}.`,
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
