import { type GoogleConnectionRow, newKeyB64 } from "@steward/core";
import { createTestDb, seedGoogleConnection } from "@steward/core/testing";
import { describe, expect, it } from "vitest";
import { GMAIL_RESPONDER, GOOGLE_CALENDAR, planWrites, SLACK_STATUS, writesAtSave } from "./plan";
import { autoReply } from "./templates";
import { zonedTimeToEpochMs } from "./time";
import type { StatusInput } from "./types";

const TZ = "Asia/Jerusalem";
const times = {
  startMs: zonedTimeToEpochMs("2026-11-12", "00:00", TZ),
  endMs: zonedTimeToEpochMs("2026-11-18", "00:00", TZ),
};
const input = (type: StatusInput["type"]): StatusInput => ({
  type,
  from: "2026-11-12",
  to: "2026-11-17",
  text: "Away",
  emoji: ":palm_tree:",
});

async function connection(overrides: Partial<GoogleConnectionRow> = {}) {
  const db = createTestDb();
  return seedGoogleConnection(db, newKeyB64(), {
    personId: "T1:U1",
    workspaceId: "T1",
    ...overrides,
  });
}

describe("writesAtSave", () => {
  it("is true for the Google systems only", () => {
    expect(writesAtSave(GOOGLE_CALENDAR)).toBe(true);
    expect(writesAtSave(GMAIL_RESPONDER)).toBe(true);
    expect(writesAtSave(SLACK_STATUS)).toBe(false);
    expect(writesAtSave("other")).toBe(false);
  });
});

describe("planWrites", () => {
  it("is Slack only without a connection", () => {
    const specs = planWrites(input("out"), times, { tz: TZ, google: null });
    expect(specs.map((s) => s.system)).toEqual([SLACK_STATUS]);
    expect(specs[0]?.args).toEqual({
      text: "Away",
      emoji: ":palm_tree:",
      expiration: Math.floor(times.endMs / 1000),
    });
  });

  it("is Slack only for remote and travelling even with a connection", async () => {
    const google = await connection();
    for (const type of ["remote", "travelling"] as const) {
      expect(planWrites(input(type), times, { tz: TZ, google }).map((s) => s.system)).toEqual([
        SLACK_STATUS,
      ]);
    }
  });

  it("plans Slack, Calendar and Gmail in that order for out, with exact args", async () => {
    const google = await connection();
    const specs = planWrites(input("out"), times, { tz: TZ, google });
    expect(specs.map((s) => [s.system, s.op])).toEqual([
      [SLACK_STATUS, "set"],
      [GOOGLE_CALENDAR, "set"],
      [GMAIL_RESPONDER, "set"],
    ]);
    expect(specs[1]?.args).toEqual({
      summary: "Away",
      from: "2026-11-12",
      to: "2026-11-17",
      tz: TZ,
      calendars: [{ id: "dana@example.com", primary: true }],
    });
    expect(specs[2]?.args).toEqual({ ...autoReply("out", times, TZ), ...times });
  });

  it("plans the Google writes for sick too", async () => {
    const google = await connection();
    expect(planWrites(input("sick"), times, { tz: TZ, google })).toHaveLength(3);
  });

  it("leaves the calendar write out when no calendar is chosen", async () => {
    const google = await connection({
      calendars: JSON.stringify([{ id: "a", summary: "A", primary: true, chosen: false }]),
    });
    expect(planWrites(input("out"), times, { tz: TZ, google }).map((s) => s.system)).toEqual([
      SLACK_STATUS,
      GMAIL_RESPONDER,
    ]);
  });

  it("lists two chosen calendars", async () => {
    const google = await connection({
      calendars: JSON.stringify([
        { id: "a", summary: "A", primary: true, chosen: true },
        { id: "b", summary: "B", primary: false, chosen: true },
        { id: "c", summary: "C", primary: false, chosen: false },
      ]),
    });
    const specs = planWrites(input("out"), times, { tz: TZ, google });
    const args = specs[1]?.args as { calendars: unknown } | undefined;
    expect(args?.calendars).toEqual([
      { id: "a", primary: true },
      { id: "b", primary: false },
    ]);
  });

  it("still plans the Google writes for a revoked connection", async () => {
    const google = await connection({ health: "revoked" });
    expect(planWrites(input("out"), times, { tz: TZ, google })).toHaveLength(3);
  });
});
