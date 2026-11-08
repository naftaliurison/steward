import { STATUS_MODAL_CALLBACK, todayIn } from "@steward/availability";
import {
  ensurePerson,
  getPerson,
  getWorkspace,
  open,
  schema,
  seal,
  upsertWorkspace,
} from "@steward/core";
import { eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
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
    let nestedRan = false;
    let rejectedRan = false;
    d.defer(
      (async () => {
        d.defer(
          (async () => {
            nestedRan = true;
          })(),
        );
      })(),
    );
    d.defer(
      (async () => {
        rejectedRan = true;
        throw new Error("boom");
      })(),
    );
    await expect(d.settle()).resolves.toBeUndefined();
    expect(ran).toBe(true);
    expect(nestedRan).toBe(true);
    expect(rejectedRan).toBe(true);
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

  it("a failed seed leaves nothing behind", async () => {
    const deps = testDeps();
    await expect(createDemoSession({ ...deps, tokenKey: "not-a-key" }, {})).rejects.toThrow();
    expect(
      await deps.db.select().from(schema.workspaces).where(like(schema.workspaces.id, "demo:%")),
    ).toHaveLength(0);
    expect(await deps.db.select().from(schema.people)).toHaveLength(0);
  });

  it("cleanup sweeps a demo workspace that has no session row", async () => {
    const deps = testDeps();
    await upsertWorkspace(deps.db, {
      id: "demo:orphan",
      name: "Acme (demo)",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-demo"),
      botUserId: "U_STEWARD",
      installedAt: NOW,
    });
    expect(await cleanupDemoSessions(deps)).toBe(0);
    expect(await getWorkspace(deps.db, "demo:orphan")).toBeNull();
  });

  it("cleanup removes expired sessions and everything they own, and nothing else", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const today = todayIn("UTC", NOW);
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const drive = async (id: string) => {
      await post(`/demo/${id}/command`, { text: "/ooo" });
      await post(`/demo/${id}/interact`, submission(today, today));
    };
    const old = await createDemoSession(deps, {});
    deps.clock.now = NOW + 30 * 60 * 1000;
    const fresh = await createDemoSession(deps, {});
    if ("error" in old || "error" in fresh) throw new Error("unexpected busy");
    deps.clock.now = NOW;
    await drive(old.id);
    await drive(fresh.id);
    await upsertWorkspace(deps.db, {
      id: "T_REAL",
      name: "Real",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-real"),
      botUserId: "U_B",
      installedAt: NOW,
    });
    const real = await ensurePerson(deps.db, "T_REAL", "U_REAL", "Real");

    const counts = async (ws: string, sessionId: string) => {
      const statuses = await deps.db
        .select()
        .from(schema.statuses)
        .where(eq(schema.statuses.workspaceId, ws));
      const ids = statuses.map((x) => x.id);
      const targets = (await deps.db.select().from(schema.statusTargets)).filter((t) =>
        ids.includes(t.statusId),
      );
      return {
        statuses: statuses.length,
        targets: targets.length,
        audit: (await deps.db.select().from(schema.audit).where(eq(schema.audit.workspaceId, ws)))
          .length,
        people: (
          await deps.db.select().from(schema.people).where(eq(schema.people.workspaceId, ws))
        ).length,
        events: (
          await deps.db
            .select()
            .from(schema.demoEvents)
            .where(eq(schema.demoEvents.sessionId, sessionId))
        ).length,
      };
    };
    const oldBefore = await counts(old.workspaceId, old.id);
    expect(oldBefore.statuses).toBeGreaterThan(0);
    expect(oldBefore.targets).toBeGreaterThan(0);
    expect(oldBefore.audit).toBeGreaterThan(0);
    expect(oldBefore.events).toBeGreaterThan(0);
    const freshBefore = await counts(fresh.workspaceId, fresh.id);
    expect(freshBefore.statuses).toBeGreaterThan(0);

    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect(await cleanupDemoSessions(deps)).toBe(1);
    expect(await getWorkspace(deps.db, old.workspaceId)).toBeNull();
    expect(await counts(old.workspaceId, old.id)).toEqual({
      statuses: 0,
      targets: 0,
      audit: 0,
      people: 0,
      events: 0,
    });
    expect(
      await deps.db.select().from(schema.demoSessions).where(eq(schema.demoSessions.id, old.id)),
    ).toHaveLength(0);
    expect(await getWorkspace(deps.db, fresh.workspaceId)).not.toBeNull();
    expect(await counts(fresh.workspaceId, fresh.id)).toEqual(freshBefore);
    expect(await getWorkspace(deps.db, "T_REAL")).not.toBeNull();
    expect(await getPerson(deps.db, real.id)).not.toBeNull();
    expect(await cleanupDemoSessions(deps)).toBe(0);
  });
});

function submission(from: string, to: string) {
  return {
    type: "view_submission",
    team: { id: "T_SOMEONE_ELSE" },
    user: { id: "U_SOMEONE_ELSE" },
    view: {
      callback_id: STATUS_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ responseUrl: "https://evil.example/x" }),
      state: {
        values: {
          type: { type: { type: "static_select", selected_option: { value: "out" } } },
          from: { from: { type: "datepicker", selected_date: from } },
          to: { to: { type: "datepicker", selected_date: to } },
          text: { text: { type: "plain_text_input", value: null } },
          emoji: { emoji: { type: "plain_text_input", value: null } },
        },
      },
    },
  };
}
