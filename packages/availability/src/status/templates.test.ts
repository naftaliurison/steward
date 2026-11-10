import { describe, expect, it } from "vitest";
import { autoReply } from "./templates";
import { zonedTimeToEpochMs } from "./time";

const TZ = "Asia/Jerusalem";
const at = (d: string) => zonedTimeToEpochMs(d, "00:00", TZ);
const several = { startMs: at("2026-11-12"), endMs: at("2026-11-18") };
const one = { startMs: at("2026-11-12"), endMs: at("2026-11-13") };

describe("autoReply", () => {
  it("out of office, several days and one day", () => {
    expect(autoReply("out", several, TZ)).toEqual({
      subject: "Out of office",
      body: "I'm out of office from Thu 12 Nov to Tue 17 Nov and will reply when I'm back.",
    });
    expect(autoReply("out", one, TZ)).toEqual({
      subject: "Out of office",
      body: "I'm out of office on Thu 12 Nov and will reply when I'm back.",
    });
  });

  it("sick, several days and one day", () => {
    expect(autoReply("sick", several, TZ)).toEqual({
      subject: "Away sick",
      body: "I'm off sick until Tue 17 Nov and will reply when I'm back.",
    });
    expect(autoReply("sick", one, TZ)).toEqual({
      subject: "Away sick",
      body: "I'm off sick today (Thu 12 Nov) and will reply when I'm back.",
    });
  });

  it("any other type, several days and one day", () => {
    expect(autoReply("travelling", several, TZ)).toEqual({
      subject: "Away",
      body: "I'm away from Thu 12 Nov to Tue 17 Nov and will reply when I'm back.",
    });
    expect(autoReply("remote", one, TZ)).toEqual({
      subject: "Away",
      body: "I'm away on Thu 12 Nov and will reply when I'm back.",
    });
  });
});
