import { getPerson } from "@steward/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { NOW, seedWorkspace, slackPost, testDeps } from "./helpers";

/** 22:30 UTC on 12 Nov is already 00:30 on 13 Nov in Asia/Jerusalem. */
const LATE = Date.UTC(2026, 10, 12, 22, 30);

const ooo = (nowMs: number) => ({
  command: "/ooo",
  text: "",
  team_id: "T1",
  user_id: "U_DANA",
  user_name: "dana",
  trigger_id: `trig-${nowMs}`,
  response_url: "https://hooks.slack.com/commands/T1/1/r1",
});

function initialFromDate(deps: ReturnType<typeof testDeps>, index: number): unknown {
  const from = deps.slack.openedViews[index]?.view.blocks[1];
  return from?.type === "input" && from.element.type === "datepicker"
    ? from.element.initial_date
    : undefined;
}

describe("person profile from Slack", () => {
  it("reads time zone and name on first contact and uses the person's today for the form", async () => {
    const deps = testDeps({ now: () => LATE });
    const app = createApp(deps);
    await seedWorkspace(deps, { profileSynced: false });
    deps.slack.users.set("U_DANA", { displayName: "Dana Levi", tz: "Asia/Jerusalem" });

    const res = await slackPost(app, "/slack/commands", ooo(LATE), LATE);
    expect(res.status).toBe(200);
    expect(initialFromDate(deps, 0)).toBe("2026-11-13");
    expect(await getPerson(deps.db, "T1:U_DANA")).toMatchObject({
      tz: "Asia/Jerusalem",
      displayName: "Dana Levi",
      profileSyncedAt: LATE,
    });
    expect(deps.slack.userInfoCalls).toEqual(["U_DANA"]);
  });

  it("does not ask Slack again within a day, and keeps what it has when Slack fails", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await seedWorkspace(deps);

    await slackPost(app, "/slack/commands", ooo(NOW), NOW);
    expect(deps.slack.userInfoCalls).toEqual([]);

    deps.clock.now = NOW + 25 * 60 * 60 * 1000;
    deps.slack.failNext.getUserInfo = "ratelimited";
    const res = await slackPost(app, "/slack/commands", ooo(deps.clock.now), deps.clock.now);
    expect(res.status).toBe(200);
    expect(deps.slack.openedViews).toHaveLength(2);
    expect((await getPerson(deps.db, "T1:U_DANA"))?.tz).toBe("Asia/Jerusalem");
  });

  it("falls back to UTC and the Slack handle when Slack doesn't know the user", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await seedWorkspace(deps, { profileSynced: false });
    await slackPost(app, "/slack/commands", ooo(NOW), NOW);
    expect(await getPerson(deps.db, "T1:U_DANA")).toMatchObject({
      tz: "UTC",
      displayName: "dana",
      profileSyncedAt: null,
    });
    expect(initialFromDate(deps, 0)).toBe("2026-11-12");
  });
});
