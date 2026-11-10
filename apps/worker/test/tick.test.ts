import { SlackStatusConnector, type StatusInput, saveStatus } from "@steward/availability";
import { ConnectorRegistry, ensurePerson, type PersonRow, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDemoSession, DEMO_SESSION_TTL_MS, demoWorkspaceId } from "../src/demo/session";
import { runStatusSteps, runTick } from "../src/tick";
import { NOW, seedWorkspace, type TestDeps, testDeps } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

const availability = (deps: TestDeps) => ({
  db: deps.db,
  registry: new ConnectorRegistry().register(new SlackStatusConnector(deps.slack)),
  now: deps.now,
});
const dana = async (deps: TestDeps): Promise<PersonRow> => {
  const [row] = await deps.db.select().from(schema.people).where(eq(schema.people.id, "T1:U_DANA"));
  if (!row) throw new Error("seed the workspace first");
  return row;
};
const out = (from: string, to: string): StatusInput => ({
  type: "out",
  from,
  to,
  text: "Out of office",
  emoji: ":palm_tree:",
});
const statusRow = async (deps: TestDeps, id: string) =>
  (await deps.db.select().from(schema.statuses).where(eq(schema.statuses.id, id)))[0];
const targetOf = async (deps: TestDeps, statusId: string) =>
  (
    await deps.db
      .select()
      .from(schema.statusTargets)
      .where(eq(schema.statusTargets.statusId, statusId))
  )[0];

describe("tick", () => {
  it("closes undo windows that have passed and leaves open ones alone", async () => {
    const deps = testDeps();
    const base = {
      workspaceId: "T1",
      personId: "T1:U1",
      type: "out",
      startMs: 0,
      endMs: NOW + DAY,
      text: "x",
      emoji: ":x:",
      state: "active",
      source: "form",
      createdAt: 0,
      replacedStatusId: null,
    };
    await deps.db.insert(schema.statuses).values([
      { ...base, id: "old", undoUntilMs: NOW - 1 },
      { ...base, id: "fresh", undoUntilMs: NOW + 60_000 },
      { ...base, id: "none", undoUntilMs: null },
    ]);
    expect(await runTick(deps)).toEqual({
      undoWindowsExpired: 1,
      scheduledEnded: 0,
      ended: 0,
      started: 0,
      retried: 0,
      demoSessionsRemoved: 0,
    });
    expect((await runTick(deps)).undoWindowsExpired).toBe(0);
  });

  it("the tick also cleans expired demo sessions", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    deps.clock.now = NOW + DEMO_SESSION_TTL_MS + 1;
    expect((await runTick(deps)).demoSessionsRemoved).toBe(1);
  });

  it("starts a scheduled status on its first day, quietly, and Cancel is over", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-13", "2026-11-14"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.startMs - 1;
    expect((await runTick(deps)).started).toBe(0);
    expect(deps.slack.statuses.size).toBe(0);

    deps.clock.now = saved.status.startMs;
    expect((await runTick(deps)).started).toBe(1);
    expect(deps.slack.statuses.get("xoxp-dana")).toMatchObject({ text: "Out of office" });
    expect(await statusRow(deps, saved.status.id)).toMatchObject({
      state: "active",
      undoUntilMs: null,
    });
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "done",
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(0);
    expect((await runTick(deps)).started).toBe(0);
  });

  it("a status that starts ends the one that was active and records it as replaced", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await dana(deps);
    const first = await saveStatus(
      availability(deps),
      person,
      out("2026-11-12", "2026-11-16"),
      "xoxp-dana",
    );
    const second = await saveStatus(
      availability(deps),
      person,
      out("2026-11-13", "2026-11-13"),
      "xoxp-dana",
    );
    deps.clock.now = second.status.startMs;
    await runTick(deps);
    expect((await statusRow(deps, first.status.id))?.state).toBe("ended");
    expect(await statusRow(deps, second.status.id)).toMatchObject({
      state: "active",
      replacedStatusId: first.status.id,
    });
  });

  it("tells the person when a status started but Slack was not connected", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await ensurePerson(deps.db, "T1", "U_NOSLACK", "No Slack");
    const saved = await saveStatus(
      availability(deps),
      person,
      out("2026-11-13", "2026-11-13"),
      null,
    );
    deps.clock.now = saved.status.startMs;
    await runTick(deps);
    expect((await targetOf(deps, saved.status.id))?.state).toBe("skipped");
    expect(deps.slack.messages).toHaveLength(1);
    expect(deps.slack.messages[0]?.channel).toBe("U_NOSLACK");
    expect(deps.slack.messages[0]?.text).toMatch(
      /^Your Out of office status \(.+\) started, but Steward couldn't set your Slack status: Slack isn't connected/,
    );
  });

  it("ends an active status when its last day is over", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-12"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.endMs - 1;
    expect((await runTick(deps)).ended).toBe(0);
    deps.clock.now = saved.status.endMs;
    expect((await runTick(deps)).ended).toBe(1);
    expect((await statusRow(deps, saved.status.id))?.state).toBe("ended");
  });

  it("ends a scheduled status whose days all passed, without touching Slack", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-13", "2026-11-13"),
      "xoxp-dana",
    );
    deps.clock.now = saved.status.endMs + 1;
    expect(await runTick(deps)).toMatchObject({ scheduledEnded: 1, started: 0, ended: 0 });
    expect(deps.slack.statuses.size).toBe(0);
    expect((await statusRow(deps, saved.status.id))?.state).toBe("ended");
  });

  it("starts at most three statuses a minute, the earliest first", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const ids: string[] = [];
    for (const [i, user] of ["U_A", "U_B", "U_C", "U_D"].entries()) {
      const person = await ensurePerson(deps.db, "T1", user, user);
      // U_A starts on the 13th, U_B on the 14th, and so on; all are due by the 17th.
      const day = `2026-11-${13 + i}`;
      ids.push(
        (await saveStatus(availability(deps), person, out(day, "2026-11-20"), null)).status.id,
      );
    }
    deps.clock.now = NOW + 5 * DAY;
    expect((await runTick(deps)).started).toBe(3);
    expect((await statusRow(deps, ids[3] ?? ""))?.state).toBe("scheduled");
    expect((await runTick(deps)).started).toBe(1);
  });

  it("tries a failed write again a minute later", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    expect(saved.targets[0]).toMatchObject({ state: "failed", nextAttemptAt: NOW + 60_000 });
    deps.clock.now = NOW + 59_000;
    expect((await runTick(deps)).retried).toBe(0);
    deps.clock.now = NOW + 60_000;
    expect((await runTick(deps)).retried).toBe(1);
    expect(deps.slack.statuses.get("xoxp-dana")).toMatchObject({ text: "Out of office" });
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "done",
      attempts: 2,
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(0);
  });

  it("gives up after the sixth failure and tells the person once", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    for (let attempt = 2; attempt <= 6; attempt++) {
      const target = await targetOf(deps, saved.status.id);
      if (target?.nextAttemptAt == null) throw new Error(`no retry planned before try ${attempt}`);
      deps.clock.now = target.nextAttemptAt;
      deps.slack.failNext.setUserStatus = "ratelimited";
      expect((await runTick(deps)).retried).toBe(1);
    }
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "failed",
      attempts: 6,
      nextAttemptAt: null,
    });
    expect(deps.slack.messages).toHaveLength(1);
    expect(deps.slack.messages[0]?.channel).toBe("U_DANA");
    expect(deps.slack.messages[0]?.text).toMatch(
      /^Steward tried six times to set your Slack status for Out of office \(.+\) and it didn't go through/,
    );
    deps.clock.now += DAY / 2;
    expect((await runTick(deps)).retried).toBe(0);
    expect(deps.slack.messages).toHaveLength(1);
  });

  it("does not retry a write whose status is no longer active", async () => {
    const deps = testDeps();
    await seedWorkspace(deps);
    const person = await dana(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const failed = await saveStatus(
      availability(deps),
      person,
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    await saveStatus(availability(deps), person, out("2026-11-12", "2026-11-12"), "xoxp-dana");
    deps.clock.now = NOW + 60_000;
    expect((await runTick(deps)).retried).toBe(0);
    expect((await targetOf(deps, failed.status.id))?.state).toBe("failed");
  });

  it("the every-minute tick leaves demo workspaces alone; a demo session runs its own steps", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const workspaceId = demoWorkspaceId(s.id);
    await deps.db.insert(schema.statuses).values({
      id: "S_DEMO",
      workspaceId,
      personId: s.youPersonId,
      type: "out",
      startMs: NOW - 1,
      endMs: NOW + DAY,
      text: "Out of office",
      emoji: ":palm_tree:",
      state: "scheduled",
      source: "form",
      createdAt: NOW - DAY,
      undoUntilMs: null,
      replacedStatusId: null,
    });
    expect((await runTick(deps)).started).toBe(0);
    expect((await statusRow(deps, "S_DEMO"))?.state).toBe("scheduled");
    expect((await runStatusSteps(deps, { workspaceId })).started).toBe(1);
    expect((await statusRow(deps, "S_DEMO"))?.state).toBe("active");
  });
});
