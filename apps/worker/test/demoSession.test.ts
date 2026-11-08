import { getPerson, getWorkspace, open, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  advanceDemoClock,
  cleanupDemoSessions,
  createDemoSession,
  DEMO_MAX_ADVANCE_MS,
  DEMO_MAX_LIVE_SESSIONS,
  DEMO_SESSION_TTL_MS,
  demoDeps,
  demoWorkspaceId,
  getDemoSession,
} from "../src/demo/session";
import { NOW, testDeps } from "./helpers";

describe("demo sessions", () => {
  it("creates a session with a workspace and three synced people; 'you' gets the visitor's zone", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, { visitorTz: "Europe/Warsaw" });
    if ("error" in s) throw new Error("unexpected busy");
    expect(s.workspaceId).toBe(demoWorkspaceId(s.id));
    expect(s.expiresAt).toBe(NOW + DEMO_SESSION_TTL_MS);
    const ws = await getWorkspace(deps.db, s.workspaceId);
    expect(ws?.name).toBe("Acme (demo)");
    expect(ws && (await open(deps.tokenKey, ws.botTokenSealed))).toBe("xoxb-demo");
    const you = await getPerson(deps.db, s.youPersonId);
    expect(you).toMatchObject({
      slackUserId: "U_DANA",
      displayName: "Dana",
      tz: "Europe/Warsaw",
      profileSyncedAt: NOW,
    });
    expect(you?.userTokenSealed && (await open(deps.tokenKey, you.userTokenSealed))).toBe(
      "xoxp-demo-U_DANA",
    );
    const people = await deps.db
      .select()
      .from(schema.people)
      .where(eq(schema.people.workspaceId, s.workspaceId));
    expect(people.map((p) => p.displayName).sort()).toEqual(["Dana", "Noa", "Omer"]);
  });

  it("falls back to UTC for an unknown visitor zone, and is not found once expired", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, { visitorTz: "Not/AZone" });
    if ("error" in s) throw new Error("unexpected busy");
    expect((await getPerson(deps.db, s.youPersonId))?.tz).toBe("UTC");
    expect(await getDemoSession(deps, s.id)).not.toBeNull();
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS;
    expect(await getDemoSession(deps, s.id)).toBeNull();
    expect(await getDemoSession(deps, "nope")).toBeNull();
  });

  it("demo deps shift the clock, run deferred work on settle, and cap the advance", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const shifted = await advanceDemoClock(deps, s, 5 * 60 * 1000);
    expect(shifted.clockOffsetMs).toBe(5 * 60 * 1000);
    const d = demoDeps(deps, shifted);
    expect(d.now()).toBe(NOW + 5 * 60 * 1000);
    let ran = false;
    d.defer(
      (async () => {
        ran = true;
      })(),
    );
    await d.settle();
    expect(ran).toBe(true);
    const capped = await advanceDemoClock(deps, shifted, DEMO_MAX_ADVANCE_MS);
    expect(capped.clockOffsetMs).toBe(DEMO_MAX_ADVANCE_MS);
  });

  it("refuses new sessions when too many are live", async () => {
    const deps = testDeps();
    for (let i = 0; i < DEMO_MAX_LIVE_SESSIONS; i++) {
      const s = await createDemoSession(deps, {});
      if ("error" in s) throw new Error(`busy too early at ${i}`);
    }
    expect(await createDemoSession(deps, {})).toEqual({ error: "busy" });
  });

  it("cleanup removes expired sessions and everything they own, and nothing else", async () => {
    const deps = testDeps();
    const old = await createDemoSession(deps, {});
    deps.clock.now = NOW + 30 * 60 * 1000;
    const fresh = await createDemoSession(deps, {});
    if ("error" in old || "error" in fresh) throw new Error("unexpected busy");
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect(await cleanupDemoSessions(deps)).toBe(1);
    expect(await getWorkspace(deps.db, old.workspaceId)).toBeNull();
    expect(
      await deps.db
        .select()
        .from(schema.people)
        .where(eq(schema.people.workspaceId, old.workspaceId)),
    ).toHaveLength(0);
    expect(
      await deps.db.select().from(schema.demoSessions).where(eq(schema.demoSessions.id, old.id)),
    ).toHaveLength(0);
    expect(await getWorkspace(deps.db, fresh.workspaceId)).not.toBeNull();
    expect(await cleanupDemoSessions(deps)).toBe(0);
  });
});
