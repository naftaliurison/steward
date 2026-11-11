import {
  type Connector,
  type ConnectorCtx,
  ConnectorRegistry,
  type Db,
  ensurePerson,
  FakeSlackClient,
  newKeyB64,
  type PersonRow,
  schema,
  upsertWorkspace,
  type WriteSpec,
} from "@steward/core";
import { createTestDb, seedGoogleConnection } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SlackStatusConnector } from "../connectors/slackStatus";
import {
  type AvailabilityDeps,
  CANCEL_TOO_LATE,
  GOOGLE_HINT,
  getStatus,
  RECOVERY_DELAY_MS,
  saveStatus,
  scheduledStatusesFor,
  UNDO_WINDOW_MS,
  undoStatus,
} from "./service";
import { zonedTimeToEpochMs } from "./time";

/** A connector that records its calls and returns an external id; it can be told to throw once. */
class StubConnector implements Connector {
  performed: WriteSpec[] = [];
  undone: string[] = [];
  failOnce = false;
  constructor(readonly system: string) {}
  async perform(spec: WriteSpec, _ctx: ConnectorCtx) {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("Google is down");
    }
    this.performed.push(spec);
    return { externalId: `${this.system}-ext` };
  }
  async undo(externalId: string, _spec: WriteSpec, _ctx: ConnectorCtx) {
    this.undone.push(externalId);
  }
}

const TZ = "Asia/Jerusalem";
const NOW = Date.UTC(2026, 10, 12, 8, 0); // Thu 12 Nov 2026, 10:00 local

describe("saveStatus / undoStatus", () => {
  let db: Db;
  let slack: FakeSlackClient;
  let deps: AvailabilityDeps;
  let dana: PersonRow;
  let clock: number;

  beforeEach(async () => {
    db = createTestDb();
    slack = new FakeSlackClient();
    clock = NOW;
    deps = {
      db,
      registry: new ConnectorRegistry().register(new SlackStatusConnector(slack)),
      now: () => clock,
    };
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme",
      botTokenSealed: "x",
      botUserId: "UBOT",
      installedAt: 0,
    });
    dana = await ensurePerson(db, "T1", "U_DANA", "Dana");
    await db.update(schema.people).set({ tz: TZ }).where(eq(schema.people.id, dana.id));
    dana = { ...dana, tz: TZ };
  });

  it("an active status sets Slack now, with expiry at the end of the last day", async () => {
    const { status, targets } = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-17", text: "Out", emoji: ":palm_tree:" },
      "xoxp-dana",
    );
    expect(status.state).toBe("active");
    expect(targets[0]?.state).toBe("done");
    expect(slack.statuses.get("xoxp-dana")).toEqual({
      text: "Out",
      emoji: ":palm_tree:",
      expiration: zonedTimeToEpochMs("2026-11-18", "00:00", TZ) / 1000,
    });
  });

  it("a future status is saved as scheduled and writes nothing yet", async () => {
    const { status, targets } = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    expect(status.state).toBe("scheduled");
    expect(targets[0]?.state).toBe("pending");
    expect(slack.statuses.size).toBe(0);
    expect(status.undoUntilMs).toBe(status.startMs);
    expect(targets[0]?.nextAttemptAt).toBe(status.startMs + RECOVERY_DELAY_MS);
  });

  it("a scheduled remote save returns its one pending target and calls no connector", async () => {
    const slackStub = new StubConnector("slack-status");
    const stubDeps = { ...deps, registry: new ConnectorRegistry().register(slackStub) };
    const { targets } = await saveStatus(
      stubDeps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.state).toBe("pending");
    expect(slackStub.performed).toHaveLength(0);
    const stored = await db.select().from(schema.statusTargets);
    expect(stored.map((t) => t.id)).toEqual(targets.map((t) => t.id));
  });

  it("a written target has no recovery time left", async () => {
    const { targets } = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    expect(targets[0]?.state).toBe("done");
    expect(targets[0]?.nextAttemptAt).toBeNull();
  });

  it("a scheduled status can be cancelled days later, as long as it has not started", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    clock = NOW + 3 * 24 * 60 * 60 * 1000;
    const result = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
    if ("error" in result) throw new Error(result.error);
    expect(result.status.state).toBe("cancelled");
    expect(result.targets[0]?.state).toBe("undone");
    expect(slack.statuses.size).toBe(0);
  });

  it("refuses to cancel once the first day has begun, in plain words", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-20", to: "2026-11-20", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    clock = saved.status.startMs;
    expect(await undoStatus(deps, saved.status.id, dana, "xoxp-dana")).toEqual({
      error: CANCEL_TOO_LATE,
    });
  });

  it("lists a person's scheduled statuses, earliest first, up to a limit", async () => {
    const save = (day: string) =>
      saveStatus(
        deps,
        dana,
        { type: "out", from: day, to: day, text: "Out", emoji: ":x:" },
        "xoxp-dana",
      );
    await save("2026-11-12"); // active today: not listed
    const later = await save("2026-11-25");
    const sooner = await save("2026-11-20");
    expect((await scheduledStatusesFor(deps.db, dana.id, 5)).map((s) => s.id)).toEqual([
      sooner.status.id,
      later.status.id,
    ]);
    expect(await scheduledStatusesFor(deps.db, dana.id, 1)).toHaveLength(1);
  });

  it("without a Slack user token the write is skipped with a plain reason", async () => {
    const { targets } = await saveStatus(
      deps,
      dana,
      { type: "sick", from: "2026-11-12", to: "2026-11-12", text: "Out sick", emoji: ":x:" },
      null,
    );
    expect(targets[0]?.state).toBe("skipped");
    expect(targets[0]?.lastError).toContain("isn't connected");
  });

  it("undo clears Slack, marks the status cancelled, and refuses after five minutes", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    const undone = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
    expect("error" in undone).toBe(false);
    if ("error" in undone) return;
    expect(undone.status.state).toBe("cancelled");
    expect(undone.targets[0]?.state).toBe("undone");
    expect(slack.statuses.get("xoxp-dana")).toBeNull();

    const again = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    clock = NOW + 6 * 60 * 1000;
    const late = await undoStatus(deps, again.status.id, dana, "xoxp-dana");
    expect(late).toEqual({ error: "The five-minute undo window has passed." });
  });

  it("saving over an active status ends the earlier one and records it as replaced", async () => {
    const first = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    const second = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-13", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    expect(second.status.replacedStatusId).toBe(first.status.id);
    const rows = await db
      .select()
      .from(schema.statuses)
      .where(eq(schema.statuses.id, first.status.id));
    expect(rows[0]?.state).toBe("ended");
  });

  it("refuses to undo someone else's status", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    const omer = await ensurePerson(db, "T1", "U_OMER", "Omer");
    expect(await undoStatus(deps, saved.status.id, omer, "xoxp-omer")).toEqual({
      error: "That status isn't yours or no longer exists.",
    });
  });

  it("undoing a status that was replaced refuses and leaves Slack alone", async () => {
    const a = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    const b = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-13", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    expect(await undoStatus(deps, a.status.id, dana, "xoxp-dana")).toEqual({
      error: "That status was already replaced by a newer one — undo the newer one instead.",
    });
    expect(slack.statuses.get("xoxp-dana")?.text).toBe("Out");
    const rows = await db.select().from(schema.statuses).where(eq(schema.statuses.id, b.status.id));
    expect(rows[0]?.state).toBe("active");
  });

  it("undo on a status the tick ended by date, after its window, says it is too late, not replaced", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    // What the minute tick does when the last day is over.
    await db
      .update(schema.statuses)
      .set({ state: "ended", undoUntilMs: null })
      .where(eq(schema.statuses.id, saved.status.id));
    clock = NOW + 2 * 24 * 60 * 60 * 1000;
    expect(await undoStatus(deps, saved.status.id, dana, "xoxp-dana")).toEqual({
      error: "The five-minute undo window has passed.",
    });
  });

  it("undo without a Slack token is reported honestly", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    const undone = await undoStatus(deps, saved.status.id, dana, null);
    expect("error" in undone).toBe(false);
    if ("error" in undone) return;
    expect(undone.targets[0]?.state).toBe("done");
    expect(undone.targets[0]?.lastError).toMatch(/^undo didn't go through — Slack isn't connected/);
    expect(slack.statuses.get("xoxp-dana")).not.toBeNull();
    expect(undone.status.state).toBe("active");
    expect(undone.status.undoUntilMs).toBe(saved.status.undoUntilMs);
    const rows = await db
      .select()
      .from(schema.statuses)
      .where(eq(schema.statuses.id, saved.status.id));
    expect(rows[0]?.state).toBe("active");
  });

  it("a scheduled status does not record a replacement", async () => {
    const active = await saveStatus(
      deps,
      dana,
      { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "Remote", emoji: ":house:" },
      "xoxp-dana",
    );
    const later = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-20", to: "2026-11-20", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    expect(later.status.state).toBe("scheduled");
    expect(later.status.replacedStatusId).toBeNull();
    const rows = await db
      .select()
      .from(schema.statuses)
      .where(eq(schema.statuses.id, active.status.id));
    expect(rows[0]?.state).toBe("active");
  });

  it("undo exactly at the window's end is refused", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    clock = NOW + UNDO_WINDOW_MS;
    expect(await undoStatus(deps, saved.status.id, dana, "xoxp-dana")).toEqual({
      error: "The five-minute undo window has passed.",
    });
  });

  it("a status from another workspace is not yours", async () => {
    const saved = await saveStatus(
      deps,
      dana,
      { type: "out", from: "2026-11-12", to: "2026-11-12", text: "Out", emoji: ":x:" },
      "xoxp-dana",
    );
    await upsertWorkspace(db, {
      id: "T2",
      name: "Other",
      botTokenSealed: "x",
      botUserId: "UB2",
      installedAt: 0,
    });
    const stranger = await ensurePerson(db, "T2", "U_DANA", "Dana");
    expect(await undoStatus(deps, saved.status.id, stranger, "xoxp-other")).toEqual({
      error: "That status isn't yours or no longer exists.",
    });
    expect((await getStatus(db, saved.status.id, "T1"))?.id).toBe(saved.status.id);
    expect(await getStatus(db, saved.status.id, "T2")).toBeNull();
    // Same personId, so only the workspace filter can reject this one.
    expect(
      await undoStatus(deps, saved.status.id, { ...dana, workspaceId: "T2" }, "xoxp-dana"),
    ).toEqual({ error: "That status isn't yours or no longer exists." });
  });

  describe("with Google", () => {
    let calendar: StubConnector;
    let gmail: StubConnector;
    const out = (from: string, to: string) =>
      ({ type: "out", from, to, text: "Out", emoji: ":palm_tree:" }) as const;

    beforeEach(async () => {
      calendar = new StubConnector("google-calendar");
      gmail = new StubConnector("gmail-responder");
      deps = {
        ...deps,
        registry: new ConnectorRegistry()
          .register(new SlackStatusConnector(slack))
          .register(calendar)
          .register(gmail),
      };
    });

    const connect = () =>
      seedGoogleConnection(db, newKeyB64(), { personId: dana.id, workspaceId: "T1" });

    it("an active out status writes Slack, the calendar and Gmail now", async () => {
      await connect();
      const { targets, notes } = await saveStatus(
        deps,
        dana,
        out("2026-11-12", "2026-11-17"),
        "xoxp-dana",
      );
      expect(targets).toHaveLength(3);
      expect(targets.map((t) => t.state)).toEqual(["done", "done", "done"]);
      expect(calendar.performed).toHaveLength(1);
      expect(gmail.performed).toHaveLength(1);
      expect(notes).toEqual([]);
    });

    it("a scheduled out status writes the Google targets at save and leaves Slack pending", async () => {
      await connect();
      const { status, targets } = await saveStatus(
        deps,
        dana,
        out("2026-11-20", "2026-11-22"),
        "xoxp-dana",
      );
      expect(status.state).toBe("scheduled");
      const by = Object.fromEntries(targets.map((t) => [t.system, t]));
      expect(by["google-calendar"]?.state).toBe("done");
      expect(by["gmail-responder"]?.state).toBe("done");
      expect(calendar.performed).toHaveLength(1);
      expect(gmail.performed).toHaveLength(1);
      expect(by["slack-status"]?.state).toBe("pending");
      expect(by["slack-status"]?.nextAttemptAt).toBe(status.startMs + RECOVERY_DELAY_MS);
      expect(targets).toHaveLength(3);
      expect(slack.statuses.size).toBe(0);
    });

    it("a Google write that throws at save is failed and retried by the engine's schedule", async () => {
      await connect();
      calendar.failOnce = true;
      const { targets } = await saveStatus(
        deps,
        dana,
        out("2026-11-20", "2026-11-22"),
        "xoxp-dana",
      );
      const cal = targets.find((t) => t.system === "google-calendar");
      expect(cal?.state).toBe("failed");
      expect(cal?.lastError).toBe("Google is down");
      expect(cal?.nextAttemptAt).toBe(NOW + 60_000);
      expect(targets.find((t) => t.system === "gmail-responder")?.state).toBe("done");
    });

    it("without Google connectors registered the save-time targets are skipped, not pending", async () => {
      await connect();
      deps = {
        ...deps,
        registry: new ConnectorRegistry().register(new SlackStatusConnector(slack)),
      };
      const { targets } = await saveStatus(
        deps,
        dana,
        out("2026-11-20", "2026-11-22"),
        "xoxp-dana",
      );
      const google = targets.filter((t) => t.system !== "slack-status");
      expect(google.map((t) => t.state)).toEqual(["skipped", "skipped"]);
      expect(google[0]?.lastError).toMatch(/^no connector for/);
    });

    it("a remote status with a connection plans only Slack", async () => {
      await connect();
      const { targets } = await saveStatus(
        deps,
        dana,
        { type: "remote", from: "2026-11-12", to: "2026-11-12", text: "R", emoji: ":house:" },
        "xoxp-dana",
      );
      expect(targets).toHaveLength(1);
      expect(calendar.performed).toHaveLength(0);
    });

    it("hints at connecting Google only for out and sick, without a connection, when asked to", async () => {
      const hinting = { ...deps, googleHint: true };
      expect((await saveStatus(hinting, dana, out("2026-11-12", "2026-11-12"), "x")).notes).toEqual(
        [GOOGLE_HINT],
      );
      expect((await saveStatus(deps, dana, out("2026-11-12", "2026-11-12"), "x")).notes).toEqual(
        [],
      );
      const remote = {
        type: "remote",
        from: "2026-11-12",
        to: "2026-11-12",
        text: "R",
        emoji: ":house:",
      } as const;
      expect((await saveStatus(hinting, dana, remote, "x")).notes).toEqual([]);
      await connect();
      expect((await saveStatus(hinting, dana, out("2026-11-12", "2026-11-12"), "x")).notes).toEqual(
        [],
      );
    });

    it("cancelling a scheduled status removes the Google writes too", async () => {
      await connect();
      const saved = await saveStatus(deps, dana, out("2026-11-20", "2026-11-22"), "xoxp-dana");
      const result = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
      if ("error" in result) throw new Error(result.error);
      expect(result.status.state).toBe("cancelled");
      expect(calendar.undone).toEqual(["google-calendar-ext"]);
      expect(gmail.undone).toEqual(["gmail-responder-ext"]);
      expect(result.targets.map((t) => t.state)).toEqual(["undone", "undone", "undone"]);
    });

    it("undoing an active status inside five minutes undoes all three", async () => {
      await connect();
      const saved = await saveStatus(deps, dana, out("2026-11-12", "2026-11-17"), "xoxp-dana");
      const result = await undoStatus(deps, saved.status.id, dana, "xoxp-dana");
      if ("error" in result) throw new Error(result.error);
      expect(result.targets.map((t) => t.state)).toEqual(["undone", "undone", "undone"]);
      expect(calendar.undone).toHaveLength(1);
      expect(gmail.undone).toHaveLength(1);
      expect(slack.statuses.get("xoxp-dana")).toBeNull();
    });
  });
});
