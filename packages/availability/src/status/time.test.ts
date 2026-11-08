import { describe, expect, it } from "vitest";
import { formatRange, nextDay, todayIn, zonedTimeToEpochMs } from "./time";

describe("zonedTimeToEpochMs", () => {
  it("converts a local midnight in Asia/Jerusalem (UTC+2 in November)", () => {
    expect(zonedTimeToEpochMs("2026-11-12", "00:00", "Asia/Jerusalem")).toBe(
      Date.UTC(2026, 10, 11, 22, 0),
    );
  });
  it("converts a local 09:00 in Europe/Warsaw in winter (UTC+1) and summer (UTC+2)", () => {
    expect(zonedTimeToEpochMs("2026-11-12", "09:00", "Europe/Warsaw")).toBe(
      Date.UTC(2026, 10, 12, 8, 0),
    );
    expect(zonedTimeToEpochMs("2026-07-01", "09:00", "Europe/Warsaw")).toBe(
      Date.UTC(2026, 6, 1, 7, 0),
    );
  });
  it("is the identity for UTC", () => {
    expect(zonedTimeToEpochMs("2026-01-01", "00:00", "UTC")).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("todayIn", () => {
  it("returns the local calendar date of an instant", () => {
    const eveningUtc = Date.UTC(2026, 10, 8, 20, 0);
    expect(todayIn("Asia/Tokyo", eveningUtc)).toBe("2026-11-09");
    expect(todayIn("America/Los_Angeles", eveningUtc)).toBe("2026-11-08");
  });
});

describe("nextDay", () => {
  it("rolls over months and years", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("formatRange", () => {
  const tz = "UTC";
  it("shows one day once and a range with an en dash", () => {
    const start = Date.UTC(2026, 10, 12);
    expect(formatRange(start, Date.UTC(2026, 10, 13), tz)).toMatch(/^Thu,? 12 Nov$/);
    expect(formatRange(start, Date.UTC(2026, 10, 18), tz)).toMatch(/^Thu,? 12 Nov – Tue,? 17 Nov$/);
  });
});
