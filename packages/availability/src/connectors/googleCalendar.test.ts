import {
  type ConnectorCtx,
  FakeGoogleClient,
  GoogleTokenSource,
  getGoogleConnection,
  newKeyB64,
  SkipWrite,
  type WriteSpec,
} from "@steward/core";
import { createTestDb, seedGoogleConnection } from "@steward/core/testing";
import { describe, expect, it } from "vitest";
import { type CalendarWriteArgs, GOOGLE_CALENDAR } from "../status/plan";
import { CONNECT_GOOGLE } from "./googleAccess";
import { DECLINE_MESSAGE, eventIdFor, GoogleCalendarConnector } from "./googleCalendar";

const PERSON = "T1:U1";
const ctx: ConnectorCtx = {
  workspaceId: "T1",
  personId: PERSON,
  userToken: null,
  idempotencyKey: "key-1",
};

function specFor(calendars: CalendarWriteArgs["calendars"]): WriteSpec {
  const args: CalendarWriteArgs = {
    summary: "Out of office",
    from: "2026-11-12",
    to: "2026-11-17",
    tz: "Asia/Jerusalem",
    calendars,
  };
  return { system: GOOGLE_CALENDAR, op: "set", args };
}
const PRIMARY = { id: "dana@example.com", primary: true };
const OTHER = { id: "team@example.com", primary: false };

async function setup(connected = true) {
  const db = createTestDb();
  const key = newKeyB64();
  if (connected) await seedGoogleConnection(db, key, { personId: PERSON, workspaceId: "T1" });
  const fake = new FakeGoogleClient();
  const tokens = new GoogleTokenSource({
    db,
    google: fake,
    tokenKey: key,
    clientId: "id",
    clientSecret: "secret",
    now: () => 1_000,
  });
  return { db, fake, connector: new GoogleCalendarConnector({ google: fake, tokens }) };
}

describe("eventIdFor", () => {
  it("is stable and shaped stw + 64 hex", async () => {
    const a = await eventIdFor("key-1");
    expect(a).toBe(await eventIdFor("key-1"));
    expect(a).toMatch(/^stw[0-9a-f]{64}$/);
    expect(a).not.toBe(await eventIdFor("key-2"));
  });
});

describe("GoogleCalendarConnector.perform", () => {
  it("inserts a timed out-of-office event on the primary calendar", async () => {
    const { fake, connector } = await setup();
    const { externalId } = await connector.perform(specFor([PRIMARY]), ctx);
    expect(externalId).toBe(await eventIdFor("key-1"));
    expect(fake.inserts).toEqual([
      {
        calendarId: PRIMARY.id,
        event: {
          id: externalId,
          summary: "Out of office",
          start: { dateTime: "2026-11-11T22:00:00.000Z" },
          end: { dateTime: "2026-11-17T22:00:00.000Z" },
          transparency: "opaque",
          eventType: "outOfOffice",
          outOfOfficeProperties: {
            autoDeclineMode: "declineOnlyNewConflictingInvitations",
            declineMessage: DECLINE_MESSAGE,
          },
        },
      },
    ]);
  });

  it("inserts an all-day event on any other calendar with the same id", async () => {
    const { fake, connector } = await setup();
    const { externalId } = await connector.perform(specFor([PRIMARY, OTHER]), ctx);
    expect(fake.inserts.map((i) => i.calendarId)).toEqual([PRIMARY.id, OTHER.id]);
    expect(fake.inserts[1]?.event).toEqual({
      id: externalId,
      summary: "Out of office",
      start: { date: "2026-11-12" },
      end: { date: "2026-11-18" },
      transparency: "opaque",
    });
  });

  it("falls back to an all-day event when out-of-office is rejected", async () => {
    const { fake, connector } = await setup();
    fake.rejectOutOfOffice = true;
    await connector.perform(specFor([PRIMARY]), ctx);
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]?.calendarId).toBe(PRIMARY.id);
    expect(fake.inserts[0]?.event.eventType).toBeUndefined();
    expect(fake.inserts[0]?.event.start).toEqual({ date: "2026-11-12" });
    expect(fake.inserts[0]?.event.end).toEqual({ date: "2026-11-18" });
  });

  it("treats a 409 as success", async () => {
    const { connector, fake } = await setup();
    fake.failNext.insertEvent = { status: 409, code: "duplicate" };
    const { externalId } = await connector.perform(specFor([PRIMARY]), ctx);
    expect(externalId).toBe(await eventIdFor("key-1"));
  });

  it("rejects on a 401 and clears the stored access token", async () => {
    const { db, fake, connector } = await setup();
    fake.failNext.insertEvent = { status: 401, code: "authError" };
    await expect(connector.perform(specFor([PRIMARY]), ctx)).rejects.toMatchObject({
      status: 401,
    });
    expect((await getGoogleConnection(db, PERSON))?.accessTokenSealed).toBeNull();
  });

  it("skips when Google is not connected, without inserting", async () => {
    const { fake, connector } = await setup(false);
    const err = await connector.perform(specFor([PRIMARY]), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(CONNECT_GOOGLE);
    expect(fake.inserts).toEqual([]);
  });

  it("gives the same externalId for the same idempotency key", async () => {
    const { fake, connector } = await setup();
    const a = await connector.perform(specFor([PRIMARY]), ctx);
    const b = await connector.perform(specFor([PRIMARY]), ctx);
    expect(b).toEqual(a);
    expect(fake.inserts).toHaveLength(1);
  });
});

describe("GoogleCalendarConnector.undo", () => {
  it("deletes the event on every listed calendar", async () => {
    const { fake, connector } = await setup();
    const spec = specFor([PRIMARY, OTHER]);
    const { externalId } = await connector.perform(spec, ctx);
    expect(fake.events.size).toBe(2);
    await connector.undo(externalId, spec, ctx);
    expect(fake.events.size).toBe(0);
  });

  it("skips an undo with a reason when there is no connection", async () => {
    const { connector } = await setup(false);
    const err = await connector.undo("stwabc", specFor([PRIMARY]), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect((err as SkipWrite).reason).toBe("Google isn't connected");
  });
});
