import { describe, expect, it } from "vitest";
import { SlackApiError } from "./client";
import { FakeSlackClient } from "./fake";

describe("FakeSlackClient", () => {
  it("records statuses per user token and clears them", async () => {
    const slack = new FakeSlackClient();
    await slack.setUserStatus({
      userToken: "xoxp-dana",
      text: "Out",
      emoji: ":palm_tree:",
      expiration: 10,
    });
    expect(slack.statuses.get("xoxp-dana")).toEqual({
      text: "Out",
      emoji: ":palm_tree:",
      expiration: 10,
    });
    await slack.clearUserStatus({ userToken: "xoxp-dana" });
    expect(slack.statuses.get("xoxp-dana")).toBeNull();
  });

  it("fails the next call of a method once when asked", async () => {
    const slack = new FakeSlackClient();
    slack.failNext.setUserStatus = "ratelimited";
    await expect(
      slack.setUserStatus({ userToken: "t", text: "x", emoji: ":x:", expiration: 0 }),
    ).rejects.toEqual(new SlackApiError("setUserStatus", "ratelimited"));
    await expect(
      slack.setUserStatus({ userToken: "t", text: "x", emoji: ":x:", expiration: 0 }),
    ).resolves.toBeUndefined();
  });

  it("answers users.info from its seeded users and records the calls", async () => {
    const slack = new FakeSlackClient();
    slack.users.set("U1", { displayName: "Dana", tz: "Asia/Jerusalem" });
    expect(await slack.getUserInfo({ botToken: "b", userId: "U1" })).toEqual({
      displayName: "Dana",
      tz: "Asia/Jerusalem",
    });
    expect(await slack.getUserInfo({ botToken: "b", userId: "U2" })).toBeNull();
    expect(slack.userInfoCalls).toEqual(["U1", "U2"]);
  });

  it("checks response_url the way the real client does", async () => {
    const slack = new FakeSlackClient();
    await expect(
      slack.respond({ responseUrl: "https://evil.example/x", text: "hi" }),
    ).rejects.toEqual(new SlackApiError("response_url", "untrusted_url"));
    expect(slack.responses).toHaveLength(0);
  });
});
