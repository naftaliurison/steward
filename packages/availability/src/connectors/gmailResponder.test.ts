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
import { GMAIL_RESPONDER, type ResponderWriteArgs } from "../status/plan";
import { AUTO_REPLY_ALREADY_ON, GmailResponderConnector } from "./gmailResponder";
import { CONNECT_GOOGLE, GOOGLE_PERMISSION } from "./googleAccess";

const PERSON = "T1:U1";
const ctx: ConnectorCtx = {
  workspaceId: "T1",
  personId: PERSON,
  userToken: null,
  idempotencyKey: "key-1",
};
const ARGS: ResponderWriteArgs = {
  subject: "Out of office",
  body: "I am away until the 18th.",
  startMs: 1_000_000,
  endMs: 2_000_000,
};
const SPEC: WriteSpec = { system: GMAIL_RESPONDER, op: "set", args: ARGS };
const MINE = {
  enableAutoReply: true,
  responseSubject: ARGS.subject,
  responseBodyPlainText: ARGS.body,
  startTime: ARGS.startMs,
  endTime: ARGS.endMs,
  restrictToContacts: false,
  restrictToDomain: false,
};

async function setup(opts: { connected?: boolean; scopes?: string } = {}) {
  const db = createTestDb();
  const key = newKeyB64();
  if (opts.connected !== false) {
    await seedGoogleConnection(db, key, {
      personId: PERSON,
      workspaceId: "T1",
      ...(opts.scopes === undefined ? {} : { scopes: opts.scopes }),
    });
  }
  const fake = new FakeGoogleClient();
  const sets: unknown[] = [];
  const original = fake.setVacation.bind(fake);
  fake.setVacation = async (args) => {
    sets.push(args.settings);
    return original(args);
  };
  const tokens = new GoogleTokenSource({
    db,
    google: fake,
    tokenKey: key,
    clientId: "id",
    clientSecret: "secret",
    now: () => 1_000,
  });
  return { db, fake, sets, connector: new GmailResponderConnector({ google: fake, tokens }) };
}

describe("GmailResponderConnector.perform", () => {
  it("turns the auto-reply on for the dates with one write", async () => {
    const { fake, sets, connector } = await setup();
    const { externalId } = await connector.perform(SPEC, ctx);
    expect(externalId).toBe(`${PERSON}:${ARGS.startMs}`);
    expect(sets).toEqual([MINE]);
    expect(fake.vacation).toEqual(MINE);
  });

  it("keeps the person's own restrict-to-contacts setting", async () => {
    const { fake, connector } = await setup();
    fake.vacation = { ...fake.vacation, restrictToContacts: true };
    await connector.perform(SPEC, ctx);
    expect(fake.vacation).toEqual({ ...MINE, restrictToContacts: true });
  });

  it("leaves an auto-reply the person set themselves alone", async () => {
    const { fake, sets, connector } = await setup();
    fake.vacation = { ...MINE, responseBodyPlainText: "My own text" };
    const before = { ...fake.vacation };
    const err = await connector.perform(SPEC, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(AUTO_REPLY_ALREADY_ON);
    expect(fake.vacation).toEqual(before);
    expect(sets).toEqual([]);
  });

  it("does not write twice when its own auto-reply is already on", async () => {
    const { sets, connector } = await setup();
    const first = await connector.perform(SPEC, ctx);
    const second = await connector.perform(SPEC, ctx);
    expect(second).toEqual(first);
    expect(sets).toHaveLength(1);
  });

  it("leaves an auto-reply with the same text but another subject alone", async () => {
    const { fake, sets, connector } = await setup();
    fake.vacation = { ...MINE, responseSubject: "Away" };
    const before = { ...fake.vacation };
    const err = await connector.perform(SPEC, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(AUTO_REPLY_ALREADY_ON);
    expect(fake.vacation).toEqual(before);
    expect(sets).toEqual([]);
  });

  it("knows its own auto-reply although Gmail rounded the times and added a newline", async () => {
    const { fake, sets, connector } = await setup();
    fake.vacation = {
      ...MINE,
      responseBodyPlainText: `${ARGS.body}
`,
      startTime: ARGS.startMs + 123,
      endTime: ARGS.endMs - 456,
    };
    const { externalId } = await connector.perform(SPEC, ctx);
    expect(externalId).toBe(`${PERSON}:${ARGS.startMs}`);
    expect(sets).toEqual([]);
  });

  it("skips when Google is not connected", async () => {
    const { connector } = await setup({ connected: false });
    const err = await connector.perform(SPEC, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(CONNECT_GOOGLE);
  });

  it("skips when the Gmail permission was not granted", async () => {
    const { sets, connector } = await setup({ scopes: "openid email" });
    const err = await connector.perform(SPEC, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(GOOGLE_PERMISSION);
    expect(sets).toEqual([]);
  });

  it("rejects on a 401 and clears the stored access token", async () => {
    const { db, fake, connector } = await setup();
    fake.failNext.getVacation = { status: 401, code: "authError" };
    await expect(connector.perform(SPEC, ctx)).rejects.toMatchObject({ status: 401 });
    expect((await getGoogleConnection(db, PERSON))?.accessTokenSealed).toBeNull();
  });
});

describe("GmailResponderConnector.undo", () => {
  it("turns its own auto-reply off and keeps the rest", async () => {
    const { fake, connector } = await setup();
    fake.vacation = { ...fake.vacation, restrictToContacts: true };
    const { externalId } = await connector.perform(SPEC, ctx);
    await connector.undo(externalId, SPEC, ctx);
    expect(fake.vacation).toEqual({ ...MINE, enableAutoReply: false, restrictToContacts: true });
  });

  it("does not touch an auto-reply the person changed meanwhile", async () => {
    const { fake, sets, connector } = await setup();
    const { externalId } = await connector.perform(SPEC, ctx);
    fake.vacation = { ...fake.vacation, responseBodyPlainText: "Changed by me" };
    await connector.undo(externalId, SPEC, ctx);
    expect(sets).toHaveLength(1);
    expect(fake.vacation.enableAutoReply).toBe(true);
    expect(fake.vacation.responseBodyPlainText).toBe("Changed by me");
  });

  it("does not touch an auto-reply with another subject", async () => {
    const { fake, sets, connector } = await setup();
    fake.vacation = { ...MINE, responseSubject: "Away" };
    await connector.undo("x", SPEC, ctx);
    expect(sets).toEqual([]);
    expect(fake.vacation.enableAutoReply).toBe(true);
  });

  it("turns its own off although Gmail rounded the times, keeping restrict-to-domain", async () => {
    const { fake, connector } = await setup();
    fake.vacation = {
      ...MINE,
      startTime: ARGS.startMs + 1000,
      endTime: ARGS.endMs + 1000,
      restrictToDomain: true,
    };
    await connector.undo("x", SPEC, ctx);
    expect(fake.vacation.enableAutoReply).toBe(false);
    expect(fake.vacation.restrictToDomain).toBe(true);
  });

  it("does nothing when the auto-reply is already off", async () => {
    const { sets, connector } = await setup();
    await connector.undo(`${PERSON}:${ARGS.startMs}`, SPEC, ctx);
    expect(sets).toEqual([]);
  });

  it("says so when Google is not connected", async () => {
    const { connector } = await setup({ connected: false });
    await expect(connector.undo("x", SPEC, ctx)).rejects.toThrow(
      "Google isn't connected — the Gmail auto-reply was left as it is",
    );
  });
});
