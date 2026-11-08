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
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import type { Deps } from "../deps";
import { isKnownTimeZone } from "../people";
import { DemoSlackClient } from "./slackClient";

export const DEMO_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEMO_MAX_LIVE_SESSIONS = 200;
export const DEMO_MAX_ADVANCE_MS = 24 * 60 * 60 * 1000;

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
  const rows = await db
    .select({ id: schema.demoSessions.id })
    .from(schema.demoSessions)
    .where(gt(schema.demoSessions.expiresAt, now));
  return rows.length;
}

/** A fresh demo tenant: workspace `demo:<id>`, three people already "connected", an hour to live. */
export async function createDemoSession(
  deps: Deps,
  opts: { visitorTz?: string },
): Promise<DemoSession | { error: "busy" }> {
  const now = deps.now();
  if ((await liveSessionCount(deps.db, now)) >= DEMO_MAX_LIVE_SESSIONS) return { error: "busy" };
  const id = newId();
  const workspaceId = demoWorkspaceId(id);
  await upsertWorkspace(deps.db, {
    id: workspaceId,
    name: "Acme (demo)",
    botTokenSealed: await seal(deps.tokenKey, "xoxb-demo"),
    botUserId: "U_STEWARD",
    installedAt: now,
  });
  let youPersonId = "";
  for (const [i, p] of DEMO_PEOPLE.entries()) {
    const person = await ensurePerson(deps.db, workspaceId, p.slackUserId, p.displayName);
    const visitorTz = opts.visitorTz && isKnownTimeZone(opts.visitorTz) ? opts.visitorTz : "UTC";
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

export async function advanceDemoClock(
  deps: Deps,
  session: DemoSession,
  byMs: number,
): Promise<DemoSession> {
  const clockOffsetMs = Math.min(DEMO_MAX_ADVANCE_MS, Math.max(0, session.clockOffsetMs + byMs));
  await deps.db
    .update(schema.demoSessions)
    .set({ clockOffsetMs })
    .where(eq(schema.demoSessions.id, session.id));
  return { ...session, clockOffsetMs };
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
      pending.push(work);
    },
    settle: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

/** Deletes every expired session and all rows its workspace owns. Returns how many sessions went. */
export async function cleanupDemoSessions(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const expired = await deps.db
    .select()
    .from(schema.demoSessions)
    .where(lte(schema.demoSessions.expiresAt, deps.now()));
  for (const s of expired) {
    const workspaceId = demoWorkspaceId(s.id);
    const statusIds = (
      await deps.db
        .select({ id: schema.statuses.id })
        .from(schema.statuses)
        .where(eq(schema.statuses.workspaceId, workspaceId))
    ).map((r) => r.id);
    if (statusIds.length > 0) {
      await deps.db
        .delete(schema.statusTargets)
        .where(inArray(schema.statusTargets.statusId, statusIds));
    }
    await deps.db.delete(schema.statuses).where(eq(schema.statuses.workspaceId, workspaceId));
    await deps.db.delete(schema.audit).where(eq(schema.audit.workspaceId, workspaceId));
    await deps.db.delete(schema.people).where(eq(schema.people.workspaceId, workspaceId));
    await deps.db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await deps.db.delete(schema.demoEvents).where(eq(schema.demoEvents.sessionId, s.id));
    await deps.db.delete(schema.demoSessions).where(eq(schema.demoSessions.id, s.id));
  }
  return expired.length;
}
