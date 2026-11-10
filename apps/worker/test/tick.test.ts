import { SlackStatusConnector, type StatusInput, saveStatus } from "@steward/availability";
import {
  ConnectorRegistry,
  ensurePerson,
  type PersonRow,
  schema,
  seal,
  setGoogleHealth,
  setPersonUserToken,
} from "@steward/core";
import { seedGoogleConnection } from "@steward/core/testing";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDemoSession, DEMO_SESSION_TTL_MS, demoWorkspaceId } from "../src/demo/session";
import { registryFor } from "../src/registry";
import { retryWeight, runStatusSteps, runTick } from "../src/tick";
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
      /^Steward tried six times to set your Slack status for Out of office \(.+\) and it didn't go through\. Set it by hand in Slack, or run \/ooo again\.$/,
    );
    deps.clock.now += DAY / 2;
    expect((await runTick(deps)).retried).toBe(0);
    expect(deps.slack.messages).toHaveLength(1);
  });

  /** A failed write that is due now, on a status that is active today. */
  const dueFailedWrite = async (deps: TestDeps) => {
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    const saved = await saveStatus(
      availability(deps),
      await dana(deps),
      out("2026-11-12", "2026-11-13"),
      "xoxp-dana",
    );
    deps.clock.now = NOW + 60_000;
    return saved;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("two overlapping ticks write a due retry to Slack once", async () => {
    const deps = testDeps();
    const saved = await dueFailedWrite(deps);
    const realSet = deps.slack.setUserStatus.bind(deps.slack);
    let writes = 0;
    deps.slack.setUserStatus = async (args) => {
      writes++;
      await settle();
      return realSet(args);
    };
    const [first, second] = await Promise.all([runStatusSteps(deps, {}), runStatusSteps(deps, {})]);
    expect(writes).toBe(1);
    expect(first.retried + second.retried).toBe(1);
    expect(await targetOf(deps, saved.status.id)).toMatchObject({ state: "done", attempts: 2 });
    expect(deps.slack.messages).toHaveLength(0);
  });

  it("when the sixth try fails, two overlapping ticks send one give-up message", async () => {
    const deps = testDeps();
    const saved = await dueFailedWrite(deps);
    await deps.db
      .update(schema.statusTargets)
      .set({ attempts: 5, nextAttemptAt: NOW })
      .where(eq(schema.statusTargets.statusId, saved.status.id));
    deps.slack.setUserStatus = async () => {
      await settle();
      throw new Error("still down");
    };
    await Promise.all([runStatusSteps(deps, {}), runStatusSteps(deps, {})]);
    expect(await targetOf(deps, saved.status.id)).toMatchObject({ state: "failed", attempts: 6 });
    expect(deps.slack.messages).toHaveLength(1);
    expect(deps.slack.messages[0]?.text).toMatch(/^Steward tried six times/);
  });

  it("a claimed retry whose tick died is due again when the lease passes", async () => {
    const deps = testDeps();
    const saved = await dueFailedWrite(deps);
    const realSet = deps.slack.setUserStatus.bind(deps.slack);
    deps.slack.setUserStatus = () => new Promise<never>(() => {});
    void runStatusSteps(deps, {});
    await settle();
    // Claimed: pushed out by the lease, nothing recorded.
    expect(await targetOf(deps, saved.status.id)).toMatchObject({
      state: "failed",
      attempts: 1,
      nextAttemptAt: NOW + 60_000 + 5 * 60_000,
    });
    deps.slack.setUserStatus = realSet;
    deps.clock.now = NOW + 60_000 + 5 * 60_000 - 1;
    expect((await runStatusSteps(deps, {})).retried).toBe(0);
    deps.clock.now = NOW + 60_000 + 5 * 60_000;
    expect((await runStatusSteps(deps, {})).retried).toBe(1);
    expect(await targetOf(deps, saved.status.id)).toMatchObject({ state: "done", attempts: 2 });
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

  it("the every-minute tick neither ends nor retries anything in a demo workspace", async () => {
    const deps = testDeps();
    const s = await createDemoSession(deps, {});
    if ("error" in s) throw new Error("unexpected busy");
    const workspaceId = demoWorkspaceId(s.id);
    const base = {
      workspaceId,
      personId: s.youPersonId,
      type: "out",
      text: "Out of office",
      emoji: ":palm_tree:",
      state: "active",
      source: "form",
      createdAt: NOW - 3 * DAY,
      undoUntilMs: null,
      replacedStatusId: null,
    };
    await deps.db.insert(schema.statuses).values([
      { ...base, id: "S_DEMO_OVER", startMs: NOW - 2 * DAY, endMs: NOW - DAY },
      { ...base, id: "S_DEMO_FAILED", startMs: NOW - 1, endMs: NOW + DAY },
    ]);
    await deps.db.insert(schema.statusTargets).values({
      id: "ST_DEMO_FAILED",
      statusId: "S_DEMO_FAILED",
      system: "slack-status",
      op: "set",
      spec: "{}",
      state: "failed",
      externalId: null,
      attempts: 2,
      lastError: "ratelimited",
      idempotencyKey: "S_DEMO_FAILED:slack-status:set",
      nextAttemptAt: NOW - 1,
    });
    let slackCalls = 0;
    for (const method of ["setUserStatus", "clearUserStatus", "postMessage"] as const) {
      const real = deps.slack[method].bind(deps.slack) as (args: never) => Promise<unknown>;
      (deps.slack as unknown as Record<string, unknown>)[method] = async (args: never) => {
        slackCalls++;
        return real(args);
      };
    }
    const before = await targetOf(deps, "S_DEMO_FAILED");
    const result = await runTick(deps);
    expect(result).toMatchObject({ scheduledEnded: 0, ended: 0, started: 0, retried: 0 });
    expect(slackCalls).toBe(0);
    expect((await statusRow(deps, "S_DEMO_OVER"))?.state).toBe("active");
    expect((await statusRow(deps, "S_DEMO_FAILED"))?.state).toBe("active");
    expect(await targetOf(deps, "S_DEMO_FAILED")).toEqual(before);
  });

  describe("Google writes", () => {
    const withGoogle = (deps: TestDeps) => ({
      db: deps.db,
      registry: registryFor(deps),
      now: deps.now,
    });
    const connected = async (deps: TestDeps): Promise<PersonRow> => {
      const person = await seedWorkspace(deps);
      await seedGoogleConnection(deps.db, deps.tokenKey, {
        personId: person.id,
        workspaceId: "T1",
      });
      return person;
    };
    const countSetVacation = (deps: TestDeps) => {
      const counter = { calls: 0 };
      const real = deps.google.setVacation.bind(deps.google);
      deps.google.setVacation = async (args) => {
        counter.calls++;
        return real(args);
      };
      return counter;
    };
    const targetFor = async (deps: TestDeps, statusId: string, system: string) =>
      (
        await deps.db
          .select()
          .from(schema.statusTargets)
          .where(
            and(
              eq(schema.statusTargets.statusId, statusId),
              eq(schema.statusTargets.system, system),
            ),
          )
      )[0];
    const dueAt = (deps: TestDeps, statusId: string, system: string, at: number) =>
      deps.db
        .update(schema.statusTargets)
        .set({ nextAttemptAt: at })
        .where(
          and(eq(schema.statusTargets.statusId, statusId), eq(schema.statusTargets.system, system)),
        );
    /** A person with a user token and a Slack write that failed once (status active today). */
    const slackPerson = async (deps: TestDeps, user: string, at: number): Promise<string> => {
      const base = await ensurePerson(deps.db, "T1", user, user);
      const person = await setPersonUserToken(
        deps.db,
        base.id,
        await seal(deps.tokenKey, `xoxp-${user}`),
      );
      deps.slack.failNext.setUserStatus = "ratelimited";
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-12", "2026-11-13"),
        `xoxp-${user}`,
      );
      await dueAt(deps, saved.status.id, "slack-status", at);
      return saved.status.id;
    };
    /** Dana's Google person: the calendar write failed at save; status active today. */
    const googleFailed = async (deps: TestDeps, at: number): Promise<string> => {
      const person = await connected(deps);
      deps.google.failNext.insertEvent = { status: 500, code: "boom" };
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-12", "2026-11-13"),
        "xoxp-dana",
      );
      await dueAt(deps, saved.status.id, "google-calendar", at);
      return saved.status.id;
    };

    it("retryWeight: Slack 1, either Google system 2", () => {
      expect(retryWeight("slack-status")).toBe(1);
      expect(retryWeight("google-calendar")).toBe(2);
      expect(retryWeight("gmail-responder")).toBe(2);
    });

    it("a scheduled status starts with Slack only: no second Google call at the start", async () => {
      const deps = testDeps();
      const person = await connected(deps);
      const vacation = countSetVacation(deps);
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-13", "2026-11-14"),
        "xoxp-dana",
      );
      expect(deps.google.inserts).toHaveLength(1);
      expect(vacation.calls).toBe(1);
      deps.clock.now = saved.status.startMs;
      expect((await runTick(deps)).started).toBe(1);
      expect(deps.slack.statuses.get("xoxp-dana")).toMatchObject({ text: "Out of office" });
      expect(deps.google.inserts).toHaveLength(1);
      expect(vacation.calls).toBe(1);
      expect(await targetFor(deps, saved.status.id, "google-calendar")).toMatchObject({
        state: "done",
        attempts: 1,
      });
      expect(await targetFor(deps, saved.status.id, "gmail-responder")).toMatchObject({
        state: "done",
        attempts: 1,
      });
    });

    it("a Google write still pending at the start is left to the retry step, not run by the start", async () => {
      const deps = testDeps();
      const person = await connected(deps);
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-13", "2026-11-14"),
        "xoxp-dana",
      );
      await deps.db
        .update(schema.statusTargets)
        .set({ state: "pending", attempts: 0, externalId: null, nextAttemptAt: NOW + DAY * 3 })
        .where(
          and(
            eq(schema.statusTargets.statusId, saved.status.id),
            eq(schema.statusTargets.system, "google-calendar"),
          ),
        );
      deps.google.events.clear();
      deps.google.inserts.length = 0;
      deps.clock.now = saved.status.startMs;
      expect((await runTick(deps)).started).toBe(1);
      expect(deps.google.inserts).toHaveLength(0);
      expect((await targetFor(deps, saved.status.id, "google-calendar"))?.state).toBe("pending");
    });

    it("retries a failed calendar write before the status starts", async () => {
      const deps = testDeps();
      const person = await connected(deps);
      deps.google.failNext.insertEvent = { status: 500, code: "boom" };
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-14", "2026-11-15"),
        "xoxp-dana",
      );
      const calendar = await targetFor(deps, saved.status.id, "google-calendar");
      expect(calendar).toMatchObject({ state: "failed", nextAttemptAt: NOW + 60_000 });
      expect(deps.google.inserts).toHaveLength(0);
      deps.clock.now = NOW + 59_000;
      expect((await runTick(deps)).retried).toBe(0);
      deps.clock.now = NOW + 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect(await targetFor(deps, saved.status.id, "google-calendar")).toMatchObject({
        state: "done",
        attempts: 2,
      });
      expect(deps.google.inserts).toHaveLength(1);
      expect((await statusRow(deps, saved.status.id))?.state).toBe("scheduled");
      expect(await targetFor(deps, saved.status.id, "slack-status")).toMatchObject({
        state: "pending",
        attempts: 0,
      });
    });

    it("never picks up a scheduled status's Slack target in the retry step", async () => {
      const deps = testDeps();
      await seedWorkspace(deps);
      const saved = await saveStatus(
        withGoogle(deps),
        await dana(deps),
        out("2026-11-14", "2026-11-15"),
        "xoxp-dana",
      );
      await dueAt(deps, saved.status.id, "slack-status", NOW - 1);
      expect((await runTick(deps)).retried).toBe(0);
      expect(deps.slack.statuses.size).toBe(0);
      expect(await targetFor(deps, saved.status.id, "slack-status")).toMatchObject({
        state: "pending",
        attempts: 0,
      });
    });

    it("budget: three Slack retries due, two run", async () => {
      const deps = testDeps();
      await seedWorkspace(deps);
      const ids = [
        await slackPerson(deps, "U_A", NOW + 1000),
        await slackPerson(deps, "U_B", NOW + 2000),
        await slackPerson(deps, "U_C", NOW + 3000),
      ];
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(2);
      const states = await Promise.all(ids.map((id) => targetFor(deps, id, "slack-status")));
      expect(states.map((t) => t?.state)).toEqual(["done", "done", "failed"]);
    });

    it("budget: a Google retry first runs alone", async () => {
      const deps = testDeps();
      const g = await googleFailed(deps, NOW + 1000);
      const a = await slackPerson(deps, "U_A", NOW + 2000);
      const b = await slackPerson(deps, "U_B", NOW + 3000);
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect((await targetFor(deps, g, "google-calendar"))?.state).toBe("done");
      expect((await targetFor(deps, a, "slack-status"))?.state).toBe("failed");
      expect((await targetFor(deps, b, "slack-status"))?.state).toBe("failed");
    });

    it("budget: a Slack retry then a Google one runs only the Slack one; Google goes next minute", async () => {
      const deps = testDeps();
      const a = await slackPerson(deps, "U_A", NOW + 1000);
      const g = await googleFailed(deps, NOW + 2000);
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect((await targetFor(deps, a, "slack-status"))?.state).toBe("done");
      expect((await targetFor(deps, g, "google-calendar"))?.state).toBe("failed");
      deps.clock.now += 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect((await targetFor(deps, g, "google-calendar"))?.state).toBe("done");
    });

    it("with the demo limits ({ starts: 2, retries: 1 }) a Google retry still runs", async () => {
      const deps = testDeps();
      const g = await googleFailed(deps, NOW + 1000);
      deps.clock.now = NOW + 10 * 60_000;
      const steps = await runStatusSteps(deps, {}, { starts: 2, retries: 1 });
      expect(steps.retried).toBe(1);
      expect((await targetFor(deps, g, "google-calendar"))?.state).toBe("done");
    });

    it("tells the person once when the calendar write fails the sixth time", async () => {
      const deps = testDeps();
      const g = await googleFailed(deps, NOW + 1000);
      await deps.db
        .update(schema.statusTargets)
        .set({ attempts: 5 })
        .where(eq(schema.statusTargets.statusId, g));
      deps.google.failNext.insertEvent = { status: 500, code: "boom" };
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect(deps.slack.messages).toHaveLength(1);
      expect(deps.slack.messages[0]?.channel).toBe("U_DANA");
      expect(deps.slack.messages[0]?.text).toMatch(
        /^Steward tried six times to add your calendar event for Out of office \(.+\) and it didn't go through\. Set it by hand, or run \/ooo again\.$/,
      );
    });

    it("tells the person once when the Gmail auto-reply fails the sixth time", async () => {
      const deps = testDeps();
      const person = await connected(deps);
      deps.google.failNext.getVacation = { status: 500, code: "boom" };
      const saved = await saveStatus(
        withGoogle(deps),
        person,
        out("2026-11-12", "2026-11-13"),
        "xoxp-dana",
      );
      await deps.db
        .update(schema.statusTargets)
        .set({ attempts: 5, nextAttemptAt: NOW + 1000 })
        .where(
          and(
            eq(schema.statusTargets.statusId, saved.status.id),
            eq(schema.statusTargets.system, "gmail-responder"),
          ),
        );
      deps.google.failNext.getVacation = { status: 500, code: "boom" };
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect(deps.slack.messages).toHaveLength(1);
      expect(deps.slack.messages[0]?.text).toMatch(
        /^Steward tried six times to turn on your Gmail auto-reply for Out of office \(.+\) and it didn't go through\. Set it by hand, or run \/ooo again\.$/,
      );
    });

    it("tells the person when a Google retry ends skipped, with the reason", async () => {
      const deps = testDeps();
      const g = await googleFailed(deps, NOW + 1000);
      const person = await dana(deps);
      await setGoogleHealth(deps.db, person.id, "revoked", NOW);
      deps.clock.now = NOW + 10 * 60_000;
      expect((await runTick(deps)).retried).toBe(1);
      expect((await targetFor(deps, g, "google-calendar"))?.state).toBe("skipped");
      expect(deps.slack.messages).toHaveLength(1);
      expect(deps.slack.messages[0]?.text).toMatch(
        /^Steward couldn't add your calendar event for Out of office \(.+\): Reconnect Google — run \/ooo google\.$/,
      );
    });
  });
});
