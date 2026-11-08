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
});
