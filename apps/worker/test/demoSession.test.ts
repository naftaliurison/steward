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
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  advanceDemoClock,
  cleanupDemoSessions,
  createDemoSession,
  DEMO_MAX_ADVANCE_MS,
  DEMO_MAX_LIVE_SESSIONS,
  DEMO_MAX_SESSIONS_PER_DAY,
  DEMO_ORPHAN_GRACE_MS,
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
    if (!shifted) throw new Error("the clock refused");
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(d.settle()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
    expect(ran).toBe(true);
    expect(nestedRan).toBe(true);
    expect(rejectedRan).toBe(true);
    const capped = await advanceDemoClock(deps, shifted, DEMO_MAX_ADVANCE_MS);
    expect(capped?.clockOffsetMs).toBe(DEMO_MAX_ADVANCE_MS);
  });

  it("demo deps carry no Google client id or secret", async () => {
    const deps = testDeps();
    expect(deps.googleClientId).not.toBeNull();
    expect(deps.googleClientSecret).not.toBeNull();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const d = demoDeps(deps, s);
    expect(d.googleClientId).toBeNull();
    expect(d.googleClientSecret).toBeNull();
  });

  it("spends one of the day's session slots per create, and refuses when the day's budget is gone", async () => {
    const deps = testDeps();
    const day = new Date(NOW).toISOString().slice(0, 10);
    const today = () => deps.db.select().from(schema.demoDays).where(eq(schema.demoDays.day, day));
    await createDemoSession(deps, {});
    await createDemoSession(deps, {});
    expect((await today())[0]?.sessions).toBe(2);

    await deps.db
      .update(schema.demoDays)
      .set({ sessions: DEMO_MAX_SESSIONS_PER_DAY })
      .where(eq(schema.demoDays.day, day));
    expect(await createDemoSession(deps, {})).toEqual({ error: "closed" });
    expect((await today())[0]?.sessions).toBe(DEMO_MAX_SESSIONS_PER_DAY); // a refusal spends nothing

    deps.clock.now = NOW + 24 * 60 * 60 * 1000; // tomorrow has its own budget
    expect(await createDemoSession(deps, {})).not.toHaveProperty("error");
  });

  it("adds each clock advance to what the database holds, never goes back, and refuses at a day ahead", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    // Every call below passes the same stale session object, as requests racing each other would.
    await advanceDemoClock(deps, s, 10 * 60 * 1000);
    expect((await advanceDemoClock(deps, s, 10 * 60 * 1000))?.clockOffsetMs).toBe(20 * 60 * 1000);
    expect((await advanceDemoClock(deps, s, -5 * 60 * 1000))?.clockOffsetMs).toBe(20 * 60 * 1000);
    expect((await advanceDemoClock(deps, s, DEMO_MAX_ADVANCE_MS))?.clockOffsetMs).toBe(
      DEMO_MAX_ADVANCE_MS,
    );
    expect(await advanceDemoClock(deps, s, 60 * 1000)).toBeNull();
  });

  it("refuses new sessions when too many are live", async () => {
    const deps = testDeps();
    for (let i = 0; i < DEMO_MAX_LIVE_SESSIONS; i++) {
      const s = await createDemoSession(deps, {});
      if ("error" in s) throw new Error(`busy too early at ${i}`);
    }
    expect(await createDemoSession(deps, {})).toEqual({ error: "full" });
  }, 30_000);

  it("a rejection nobody has awaited yet is not an unhandled rejection", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const d = demoDeps(deps, s);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      d.defer(Promise.reject(new Error("early")));
      await new Promise((r) => setTimeout(r, 20));
      await d.settle();
      expect(unhandled).toEqual([]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errSpy.mockRestore();
    }
  });

  it("a seal failure leaves nothing behind", async () => {
    const deps = testDeps();
    await expect(createDemoSession({ ...deps, tokenKey: "not-a-key" }, {})).rejects.toThrow();
    expect(
      await deps.db.select().from(schema.workspaces).where(like(schema.workspaces.id, "demo:%")),
    ).toHaveLength(0);
    expect(await deps.db.select().from(schema.people)).toHaveLength(0);
  });

  it("a failure after the workspace and people exist rolls everything back and rethrows", async () => {
    const deps = testDeps();
    const real = deps.db;
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === schema.demoSessions) throw new Error("boom");
            return target.insert(table as never);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(createDemoSession({ ...deps, db: failing }, {})).rejects.toThrow("boom");
    expect(
      await real.select().from(schema.workspaces).where(like(schema.workspaces.id, "demo:%")),
    ).toHaveLength(0);
    expect(await real.select().from(schema.people)).toHaveLength(0);
    expect(await real.select().from(schema.demoSessions)).toHaveLength(0);
  });

  const insertOrphan = async (
    deps: ReturnType<typeof testDeps>,
    installedAt: number,
    id = "demo:orphan",
  ) =>
    upsertWorkspace(deps.db, {
      id,
      name: "Acme (demo)",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-demo"),
      botUserId: "U_STEWARD",
      installedAt,
    });

  it("cleanup sweeps a demo workspace that has no session row once it is past the grace", async () => {
    const deps = testDeps();
    await insertOrphan(deps, NOW - DEMO_ORPHAN_GRACE_MS - 1);
    expect(await cleanupDemoSessions(deps)).toBe(0);
    expect(await getWorkspace(deps.db, "demo:orphan")).toBeNull();
  });

  it("cleanup matches the demo: prefix exactly and case-sensitively", async () => {
    const deps = testDeps();
    const old = NOW - DEMO_ORPHAN_GRACE_MS - 1;
    await upsertWorkspace(deps.db, {
      id: "DEMO:UPPER",
      name: "Not a demo",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-x"),
      botUserId: "U_B",
      installedAt: old,
    });
    await insertOrphan(deps, old, "demo:old-orphan");
    await cleanupDemoSessions(deps);
    expect(await getWorkspace(deps.db, "DEMO:UPPER")).not.toBeNull();
    expect(await getWorkspace(deps.db, "demo:old-orphan")).toBeNull();
  });

  it("a failing expired-sessions step does not stop the orphan sweep", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    await insertOrphan(deps, NOW - DEMO_ORPHAN_GRACE_MS - 1);
    let armed = true;
    const failing = new Proxy(deps.db, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return (table: unknown) => {
            if (armed && table === schema.statuses) {
              armed = false;
              throw new Error("boom");
            }
            return target.delete(table as never);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await cleanupDemoSessions({ ...deps, db: failing })).toBe(0);
      expect(errors).toHaveBeenCalledWith("demo cleanup failed", expect.anything());
    } finally {
      errors.mockRestore();
    }
    expect(await getWorkspace(deps.db, "demo:orphan")).toBeNull();
  });

  it("cleanup leaves a recent session-less demo workspace alone (a create may be in flight)", async () => {
    const deps = testDeps();
    await insertOrphan(deps, NOW);
    expect(await cleanupDemoSessions(deps)).toBe(0);
    expect(await getWorkspace(deps.db, "demo:orphan")).not.toBeNull();
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
    await deps.db.insert(schema.statuses).values({
      id: "S_REAL",
      workspaceId: "T_REAL",
      personId: real.id,
      type: "out",
      startMs: NOW,
      endMs: NOW + 1000,
      text: "",
      emoji: "",
      state: "scheduled",
      source: "form",
      createdAt: NOW,
    });
    await deps.db.insert(schema.statusTargets).values({
      id: "ST_REAL",
      statusId: "S_REAL",
      system: "slack",
      op: "set",
      spec: "{}",
      state: "done",
      idempotencyKey: "k-real",
    });
    await deps.db.insert(schema.audit).values({
      id: "A_REAL",
      workspaceId: "T_REAL",
      personId: real.id,
      action: "set",
      result: "ok",
      at: NOW,
    });

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
    expect(await counts("T_REAL", "none")).toEqual({
      statuses: 1,
      targets: 1,
      audit: 1,
      people: 1,
      events: 0,
    });
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
