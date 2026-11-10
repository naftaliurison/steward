import { describe, expect, it } from "vitest";
import { GoogleApiError } from "./client";
import { FakeGoogleClient } from "./fake";

const event = {
  id: "stwabc",
  summary: "Out of office",
  start: { date: "2026-11-12" },
  end: { date: "2026-11-18" },
  transparency: "opaque" as const,
};

describe("FakeGoogleClient", () => {
  it("holds events by calendar and id, and answers 409 for a second insert", async () => {
    const google = new FakeGoogleClient();
    await google.insertEvent({ accessToken: "t", calendarId: "c1", event });
    expect(google.events.get("c1/stwabc")).toEqual(event);
    await expect(
      google.insertEvent({ accessToken: "t", calendarId: "c1", event }),
    ).rejects.toMatchObject({ status: 409, code: "duplicate" });
    await google.deleteEvent({ accessToken: "t", calendarId: "c1", eventId: "stwabc" });
    await google.deleteEvent({ accessToken: "t", calendarId: "c1", eventId: "stwabc" });
    expect(google.events.size).toBe(0);
    expect(google.inserts).toHaveLength(1);
  });

  it("can refuse out-of-office events the way some accounts do", async () => {
    const google = new FakeGoogleClient();
    google.rejectOutOfOffice = true;
    const ooo = { ...event, eventType: "outOfOffice" as const };
    await expect(
      google.insertEvent({ accessToken: "t", calendarId: "c1", event: ooo }),
    ).rejects.toMatchObject({ status: 400 });
    await google.insertEvent({ accessToken: "t", calendarId: "c1", event });
    expect(google.events.size).toBe(1);
  });

  it("fails the next call to a method once, then works", async () => {
    const google = new FakeGoogleClient();
    google.failNext.getVacation = { status: 500, code: "backendError" };
    await expect(google.getVacation({ accessToken: "t" })).rejects.toBeInstanceOf(GoogleApiError);
    expect((await google.getVacation({ accessToken: "t" })).enableAutoReply).toBe(false);
  });

  it("records token calls and keeps the auto-reply it was given", async () => {
    const google = new FakeGoogleClient();
    const creds = { clientId: "client-id", clientSecret: "client-secret" };
    expect(
      (await google.exchangeCode({ ...creds, code: "c", redirectUri: "u" })).refreshToken,
    ).toBe("1//refresh");
    expect(
      (await google.refreshAccessToken({ ...creds, refreshToken: "1//refresh" })).accessToken,
    ).toBe("ya29.fresh");
    await google.revokeToken({ token: "1//refresh" });
    expect(google.exchangedCodes).toEqual(["c"]);
    expect(google.refreshes).toEqual(["1//refresh"]);
    expect(google.revoked).toEqual(["1//refresh"]);
    const settings = {
      enableAutoReply: true,
      responseSubject: "Out of office",
      responseBodyPlainText: "Hello",
      startTime: 1,
      endTime: 2,
    };
    await google.setVacation({ accessToken: "t", settings });
    expect(await google.getVacation({ accessToken: "t" })).toEqual(settings);
  });
});
