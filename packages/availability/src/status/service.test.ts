import {
  ConnectorRegistry,
  type Db,
  ensurePerson,
  FakeSlackClient,
  type PersonRow,
  schema,
  upsertWorkspace,
} from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { SlackStatusConnector } from "../connectors/slackStatus";
import { type AvailabilityDeps, saveStatus, UNDO_WINDOW_MS, undoStatus } from "./service";
import { zonedTimeToEpochMs } from "./time";

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
});
