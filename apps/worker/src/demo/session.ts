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
import { and, count, eq, gt, inArray, like, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Deps } from "../deps";
import { isKnownTimeZone } from "../people";
import { DemoSlackClient } from "./slackClient";

export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * The demo's write budget. D1's free tier allows 100,000 row writes a day, shared with real
 * workspaces. A save-and-undo cycle records 5 events and writes about 20 rows, so a session capped
 * at 40 events writes about 200 rows with its seed and cleanup, and 150 sessions a day keep the
 * demo near 30,000 writes: under a third of the allowance.
 */
export const DEMO_MAX_LIVE_SESSIONS = 50;
export const DEMO_MAX_SESSIONS_PER_DAY = 150;
export const DEMO_MAX_EVENTS = 40;
export const DEMO_MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;
/** A session-less demo workspace younger than this may still be mid-create; the sweep leaves it be. */
export const DEMO_ORPHAN_GRACE_MS = 5 * 60 * 1000;

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
): Promise<DemoSession | { error: "busy" }> {
  const now = deps.now();
  if ((await liveSessionCount(deps.db, now)) >= DEMO_MAX_LIVE_SESSIONS) return { error: "busy" };
  // The live cap above is a soft check: creates racing each other can overshoot it by a few.
  // The day's budget is exact.
  if (!(await claimDailySlot(deps.db, now))) return { error: "busy" };
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
        await seal(deps.tokenKey, `xoxp-demo-${p.slackUserId}`),
      );
      if (i === 0) youPersonId = person.id;
    }
    const row: DemoSessionRow = {
      id,
      createdAt: now,
      expiresAt: now + DEMO_SESSION_TTL_MS,
      clockOffsetMs: 0,
      youPersonId,
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
 * Deletes every expired session and all rows its workspace owns, and sweeps demo workspaces whose
 * session row is gone and that are older than the grace (a seed that died half way). Returns how many expired sessions went.
 */
export async function cleanupDemoSessions(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const expired = await deps.db
    .select()
    .from(schema.demoSessions)
    .where(lte(schema.demoSessions.expiresAt, deps.now()));
  let removed = 0;
  for (const s of expired) {
    try {
      await deleteDemoWorkspace(deps.db, s.id);
      removed++;
    } catch (err) {
      console.error("demo cleanup failed", { session: s.id, err });
    }
  }
  try {
    const orphans = await deps.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          like(schema.workspaces.id, "demo:%"),
          lte(schema.workspaces.installedAt, deps.now() - DEMO_ORPHAN_GRACE_MS),
          notInArray(
            schema.workspaces.id,
            deps.db
              .select({ id: sql<string>`'demo:' || ${schema.demoSessions.id}` })
              .from(schema.demoSessions),
          ),
        ),
      );
    for (const w of orphans) {
      const sessionId = w.id.slice("demo:".length);
      try {
        await deleteDemoWorkspace(deps.db, sessionId);
      } catch (err) {
        console.error("demo orphan sweep failed", { session: sessionId, err });
      }
    }
  } catch (err) {
    console.error("demo orphan sweep query failed", { err });
  }
  return removed;
}
