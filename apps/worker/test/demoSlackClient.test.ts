import { header, newId, SlackApiError, schema } from "@steward/core";
import { createTestDb } from "@steward/core/testing";
import { describe, expect, it } from "vitest";
import { DemoSlackClient, readDemoEvents } from "../src/demo/slackClient";

describe("DemoSlackClient", () => {
  it("records views, responses and statuses in order, per session", async () => {
    const db = createTestDb();
    let t = 1_000;
    const slack = new DemoSlackClient(db, "S1", () => t++);
    const other = new DemoSlackClient(db, "S2", () => 5);
    await slack.openView({
      botToken: "b",
      triggerId: "trig",
      view: {
        type: "modal",
        callback_id: "cb",
        title: { type: "plain_text", text: "t" },
        blocks: [header("h")],
      },
    });
    await slack.setUserStatus({
      userToken: "xoxp-demo-U_DANA",
      text: "Out",
      emoji: ":palm_tree:",
      expiration: 99,
    });
    await slack.respond({
      responseUrl: "https://hooks.slack.com/demo/S1",
      text: "receipt",
      blocks: [header("r")],
    });
    await slack.clearUserStatus({ userToken: "xoxp-demo-U_DANA" });
    await other.setUserStatus({
      userToken: "xoxp-demo-U_OMER",
      text: "x",
      emoji: ":x:",
      expiration: 0,
    });

    const events = await readDemoEvents(db, "S1");
    expect(events.map((e) => [e.seq, e.kind, e.at])).toEqual([
      [1, "view", 1000],
      [2, "status", 1001],
      [3, "response", 1002],
      [4, "status", 1003],
    ]);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      triggerId: "trig",
      view: { callback_id: "cb" },
    });
    expect(JSON.parse(events[1]?.payload ?? "{}")).toEqual({
      slackUserId: "U_DANA",
      status: { text: "Out", emoji: ":palm_tree:", expiration: 99 },
    });
    expect(JSON.parse(events[2]?.payload ?? "{}")).toMatchObject({
      text: "receipt",
      replaceOriginal: false,
    });
    expect(JSON.parse(events[3]?.payload ?? "{}")).toEqual({
      slackUserId: "U_DANA",
      status: null,
    });
    expect(await readDemoEvents(db, "S2")).toHaveLength(1);
  });

  it("records whose status it is, never the token", async () => {
    const db = createTestDb();
    const slack = new DemoSlackClient(db, "S1", () => 1);
    await slack.setUserStatus({
      userToken: "xoxp-demo-U_NOA",
      text: "Out",
      emoji: ":x:",
      expiration: 0,
    });
    await slack.clearUserStatus({ userToken: "something-else" });
    const payloads = (await readDemoEvents(db, "S1")).map((e) => e.payload);
    expect(JSON.parse(payloads[0] ?? "{}")).toMatchObject({ slackUserId: "U_NOA" });
    expect(JSON.parse(payloads[1] ?? "{}")).toEqual({ slackUserId: "unknown", status: null });
    expect(payloads.join("")).not.toContain("xoxp");
  });

  it("refuses untrusted response URLs like the real client and answers users.info with null", async () => {
    const db = createTestDb();
    const slack = new DemoSlackClient(db, "S1", () => 1);
    await expect(
      slack.respond({ responseUrl: "https://evil.example/x", text: "hi" }),
    ).rejects.toEqual(new SlackApiError("response_url", "untrusted_url"));
    expect(await readDemoEvents(db, "S1")).toHaveLength(0);
    expect(await slack.getUserInfo({ botToken: "b", userId: "U" })).toBeNull();
  });

  it("numbers events 1, 2, 3 per session, and the database refuses a repeated number", async () => {
    const db = createTestDb();
    const a = new DemoSlackClient(db, "A", () => 1);
    const b = new DemoSlackClient(db, "B", () => 1);
    await a.clearUserStatus({ userToken: "t" });
    await b.clearUserStatus({ userToken: "t" });
    await a.clearUserStatus({ userToken: "t" });
    await a.clearUserStatus({ userToken: "t" });
    expect((await readDemoEvents(db, "A")).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await readDemoEvents(db, "B")).map((e) => e.seq)).toEqual([1]);
    await expect(
      db
        .insert(schema.demoEvents)
        .values({ id: newId(), sessionId: "A", seq: 2, kind: "status", payload: "{}", at: 1 }),
    ).rejects.toThrow();
  });

  it("records a message without the token that sent it", async () => {
    const db = createTestDb();
    const slack = new DemoSlackClient(db, "S1", () => 1);
    await slack.postMessage({ botToken: "xoxb-demo", channel: "U_DANA", text: "hello" });
    const events = await readDemoEvents(db, "S1");
    expect(events.map((e) => e.kind)).toEqual(["message"]);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toEqual({
      channel: "U_DANA",
      text: "hello",
      blocks: [],
    });
  });
});
