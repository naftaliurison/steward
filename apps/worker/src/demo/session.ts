import {
  type Db,
  type DemoSessionRow,
  ensurePerson,
  newId,
  schema,
  seal,
  setPersonUserToken,
  updatePersonProfile,
  upsertWorkspace,
} from "@steward/core";
import { and, count, eq, gt, inArray, lt, lte, notInArray, type SQL, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { isKnownTimeZone } from "../people";
import { DEMO_USER_TOKEN_PREFIX, DemoSlackClient } from "./slackClient";

export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * The demo's write budget. D1's free tier allows 100,000 row writes a day, shared with real
 * workspaces, and it bills every index entry and every delete as a row. Measured that way a
 * session costs about 80 billed rows to seed and clean up and about 25 per save, so a session
 * that spends all 24 actions on saves bills about 700 rows, and 60 sessions a day keep the demo
 * under 45,000: less than half the allowance in the worst case.
 */
export const DEMO_MAX_LIVE_SESSIONS = 20;
export const DEMO_MAX_SESSIONS_PER_DAY = 60;
export const DEMO_MAX_ACTIONS = 24;
export const DEMO_MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;
/** A session-less demo workspace younger than this may still be mid-create; the sweep leaves it be. */
export const DEMO_ORPHAN_GRACE_MS = 5 * 60 * 1000;
/** Budget rows (`demo_days`) older than this are deleted by cleanup. */
const DEMO_DAY_ROWS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** The sample team. The first one is "you"; their zone follows the visitor's browser. */
export const DEMO_PEOPLE = [
  { slackUserId: "U_DANA", displayName: "Dana", tz: "Europe/London" },
  { slackUserId: "U_OMER", displayName: "Omer", tz: "America/New_York" },
  { slackUserId: "U_NOA", displayName: "Noa", tz: "Asia/Jerusalem" },
] as const;

export type DemoSession = DemoSessionRow & { workspaceId: string };

export const demoWorkspaceId = (sessionId: string): string => `demo:${sessionId}`;

const withWorkspace = (row: DemoSessionRow): DemoSession => ({
  ...row,
  workspaceId: demoWorkspaceId(row.id),
});

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

/** A fresh demo tenant: workspace `demo:<id>`, three people already "connected", an hour to live. */
export async function createDemoSession(
  deps: Deps,
  opts: { visitorTz?: string },
): Promise<DemoSession | { error: "full" | "closed" }> {
  const now = deps.now();
  if ((await liveSessionCount(deps.db, now)) >= DEMO_MAX_LIVE_SESSIONS) return { error: "full" };
  // The live cap above is a soft check: creates racing each other can overshoot it by a few.
  // The day's budget is exact.
  // A seed that throws after this point keeps its slot for the day: the budget fails closed.
  if (!(await claimDailySlot(deps.db, now))) return { error: "closed" };
  const id = newId();
  try {
    const workspaceId = demoWorkspaceId(id);
    await upsertWorkspace(deps.db, {
      id: workspaceId,
      name: "Acme (demo)",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-demo"),
      botUserId: "U_STEWARD",
      installedAt: now,
    });
    const visitorTz = opts.visitorTz && isKnownTimeZone(opts.visitorTz) ? opts.visitorTz : "UTC";
    let youPersonId = "";
    for (const [i, p] of DEMO_PEOPLE.entries()) {
      const person = await ensurePerson(deps.db, workspaceId, p.slackUserId, p.displayName);
      const tz = i === 0 ? visitorTz : p.tz;
      await updatePersonProfile(deps.db, person.id, {
        displayName: p.displayName,
        tz,
        profileSyncedAt: now,
      });
      await setPersonUserToken(
        deps.db,
        person.id,
        await seal(deps.tokenKey, `${DEMO_USER_TOKEN_PREFIX}${p.slackUserId}`),
      );
      if (i === 0) youPersonId = person.id;
    }
    const row: DemoSessionRow = {
      id,
      createdAt: now,
      expiresAt: now + DEMO_SESSION_TTL_MS,
      clockOffsetMs: 0,
      youPersonId,
      actionsUsed: 0,
    };
    await deps.db.insert(schema.demoSessions).values(row);
    return withWorkspace(row);
  } catch (err) {
    try {
      await deleteDemoWorkspace(deps.db, id);
    } catch (cleanupErr) {
      console.error("demo session cleanup after failed seed failed", {
        session: id,
        err: cleanupErr,
      });
    }
    throw err;
  }
}

export async function getDemoSession(
  deps: Pick<Deps, "db" | "now">,
  id: string,
): Promise<DemoSession | null> {
  const rows = await deps.db
    .select()
    .from(schema.demoSessions)
    .where(and(eq(schema.demoSessions.id, id), gt(schema.demoSessions.expiresAt, deps.now())));
  const row = rows[0];
  return row ? withWorkspace(row) : null;
}

/** Takes one of the session's actions. One statement, so requests racing each other cannot overshoot. False when the session has none left. */
export async function claimDemoAction(
  deps: Pick<Deps, "db">,
  session: DemoSession,
): Promise<boolean> {
  const used = schema.demoSessions.actionsUsed;
  const rows = await deps.db
    .update(schema.demoSessions)
    .set({ actionsUsed: sql`${used} + 1` })
    .where(and(eq(schema.demoSessions.id, session.id), lt(used, DEMO_MAX_ACTIONS)))
    .returning({ actionsUsed: used });
  return rows.length > 0;
}

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

/**
 * The deps a demo request runs with: the recording Slack client, the session's shifted clock, and a
 * `defer` that collects work so the route can `settle()` it before answering — the emulator must see
 * the receipt in the same round trip.
 */
export function demoDeps(deps: Deps, session: DemoSession): Deps & { settle: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const now = () => deps.now() + session.clockOffsetMs;
  return {
    ...deps,
    now,
    slack: new DemoSlackClient(deps.db, session.id, now),
    defer: (work) => {
      // Handle the rejection right away so it is never unhandled while it waits for settle().
      pending.push(
        work.catch((err) => {
          console.error("demo deferred work failed", { session: session.id, err });
        }),
      );
    },
    settle: async () => {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

/** Deletes a demo workspace and everything it owns, plus its session and event rows. */
export async function deleteDemoWorkspace(db: Db, sessionId: string): Promise<void> {
  const workspaceId = demoWorkspaceId(sessionId);
  await db
    .delete(schema.statusTargets)
    .where(
      inArray(
        schema.statusTargets.statusId,
        db
          .select({ id: schema.statuses.id })
          .from(schema.statuses)
          .where(eq(schema.statuses.workspaceId, workspaceId)),
      ),
    );
  await db.delete(schema.statuses).where(eq(schema.statuses.workspaceId, workspaceId));
  await db.delete(schema.audit).where(eq(schema.audit.workspaceId, workspaceId));
  await db.delete(schema.people).where(eq(schema.people.workspaceId, workspaceId));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await db.delete(schema.demoEvents).where(eq(schema.demoEvents.sessionId, sessionId));
  await db.delete(schema.demoSessions).where(eq(schema.demoSessions.id, sessionId));
}

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
  let removed = row?.n ?? 0;
  if (removed > 0) {
    // Its own try: a failure here must not stop the sweep below.
    try {
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
    } catch (err) {
      console.error("demo cleanup failed", { err });
      removed = 0;
    }
  }

  try {
    await deleteOwnedBy(
      deps.db,
      sql`(select ${workspaces.id} from ${workspaces} where substr(${workspaces.id}, 1, 5) = 'demo:' and ${workspaces.installedAt} <= ${now - DEMO_ORPHAN_GRACE_MS} and ${workspaces.id} not in (select 'demo:' || ${sessions.id} from ${sessions}))`,
    );
    // Events are only ever written for a session that exists, so an event without one is safe to delete.
    await deps.db
      .delete(schema.demoEvents)
      .where(
        notInArray(schema.demoEvents.sessionId, sql`(select ${sessions.id} from ${sessions})`),
      );
    await deps.db
      .delete(schema.demoDays)
      .where(
        lt(schema.demoDays.day, new Date(now - DEMO_DAY_ROWS_KEPT_MS).toISOString().slice(0, 10)),
      );
  } catch (err) {
    console.error("demo sweep failed", { err });
  }
  return removed;
}
