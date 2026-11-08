import { header, SlackApiError } from "@steward/core";
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
      userToken: "xoxp-demo-U_DANA",
      status: { text: "Out", emoji: ":palm_tree:", expiration: 99 },
    });
    expect(JSON.parse(events[2]?.payload ?? "{}")).toMatchObject({
      text: "receipt",
      replaceOriginal: false,
    });
    expect(JSON.parse(events[3]?.payload ?? "{}")).toEqual({
      userToken: "xoxp-demo-U_DANA",
      status: null,
    });
    expect(await readDemoEvents(db, "S2")).toHaveLength(1);
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
});
