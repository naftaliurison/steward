import { STATUS_MODAL_CALLBACK, UNDO_ACTION, zonedTimeToEpochMs } from "@steward/availability";
import { type Block, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { flush, NOW, seedWorkspace, slackPost, type TestDeps, TZ, testDeps } from "./helpers";

const RESPONSE_URL = "https://hooks.slack.test/r1";

function submission(v: { type: string; from: string; to: string; text?: string; emoji?: string }) {
  return {
    type: "view_submission",
    team: { id: "T1" },
    user: { id: "U_DANA", username: "dana" },
    view: {
      callback_id: STATUS_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ responseUrl: RESPONSE_URL }),
      state: {
        values: {
          type: { type: { type: "static_select", selected_option: { value: v.type } } },
          from: { from: { type: "datepicker", selected_date: v.from } },
          to: { to: { type: "datepicker", selected_date: v.to } },
          text: { text: { type: "plain_text_input", value: v.text ?? null } },
          emoji: { emoji: { type: "plain_text_input", value: v.emoji ?? null } },
        },
      },
    },
  };
}

function undoValue(blocks: Block[]): string | undefined {
  const act = blocks.find((b) => b.type === "actions");
  const el = act?.type === "actions" ? act.elements[0] : undefined;
  return el?.type === "button" && el.action_id === UNDO_ACTION ? el.value : undefined;
}

describe("/ooo", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    deps = testDeps();
    app = createApp(deps);
  });

  it("rejects an unsigned request", async () => {
    const res = await app.request("/slack/commands", { method: "POST", body: "command=%2Fooo" });
    expect(res.status).toBe(401);
  });

  it("answers health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("opens the status form with the response_url tucked in", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo",
      text: "",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "trig-1",
      response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    expect(deps.slack.openedViews).toHaveLength(1);
    const opened = deps.slack.openedViews[0];
    expect(opened?.triggerId).toBe("trig-1");
    expect(opened?.view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    expect(JSON.parse(opened?.view.private_metadata ?? "{}")).toEqual({
      responseUrl: RESPONSE_URL,
    });
  });

  it("saves a status, sets Slack, sends a receipt with Undo, and Undo clears it", async () => {
    await seedWorkspace(deps);
    const save = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-17" })),
    });
    expect(await save.json()).toEqual({ response_action: "clear" });
    await flush(deps);
    expect(deps.slack.statuses.get("xoxp-dana")).toEqual({
      text: "Out of office",
      emoji: ":palm_tree:",
      expiration: zonedTimeToEpochMs("2026-11-18", "00:00", TZ) / 1000,
    });
    const receipt = deps.slack.responses[0];
    expect(receipt?.responseUrl).toBe(RESPONSE_URL);
    expect(receipt?.text).toMatch(/^Out of office · /);
    expect(JSON.stringify(receipt?.blocks)).toContain("✅ Slack status set");
    const statusId = undoValue(receipt?.blocks ?? []);
    expect(statusId).toBeTruthy();

    const undo = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U_DANA", username: "dana" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    });
    expect(undo.status).toBe(200);
    await flush(deps);
    expect(deps.slack.statuses.get("xoxp-dana")).toBeNull();
    const replaced = deps.slack.responses[1];
    expect(replaced?.replaceOriginal).toBe(true);
    expect(replaced?.text).toMatch(/^Undone · Out of office/);
    expect(JSON.stringify(replaced?.blocks)).toContain("↩️ Slack status cleared");
  });

  it("says plainly when Slack isn't connected for the person", async () => {
    await seedWorkspace(deps, { withUserToken: false });
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "sick", from: "2026-11-12", to: "2026-11-12" })),
    });
    await flush(deps);
    expect(deps.slack.statuses.size).toBe(0);
    expect(JSON.stringify(deps.slack.responses[0]?.blocks)).toContain(
      "➖ Slack status skipped — Slack isn't connected",
    );
  });

  it("returns field errors to the form instead of saving", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-11" })),
    });
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { to: "The last day has already passed." },
    });
    expect(deps.deferred).toHaveLength(0);
    expect(deps.slack.responses).toHaveLength(0);
  });

  it("refuses a first day in the future with a plain field error, before saving anything", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-13", to: "2026-11-14" })),
    });
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { from: "Scheduling arrives in a later version — for now, the first day is today." },
    });
    expect(deps.deferred).toHaveLength(0);
    expect(deps.slack.statuses.size).toBe(0);
  });

  it("refuses Undo after five minutes with a plain message", async () => {
    await seedWorkspace(deps);
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    await flush(deps);
    const statusId = undoValue(deps.slack.responses[0]?.blocks ?? []);
    deps.clock.now = NOW + 6 * 60 * 1000;
    await slackPost(
      app,
      "/slack/interactions",
      {
        payload: JSON.stringify({
          type: "block_actions",
          team: { id: "T1" },
          user: { id: "U_DANA" },
          response_url: RESPONSE_URL,
          actions: [{ action_id: UNDO_ACTION, value: statusId }],
        }),
      },
      deps.clock.now,
    );
    await flush(deps);
    expect(deps.slack.responses[1]?.text).toBe("The five-minute undo window has passed.");
    expect(deps.slack.statuses.get("xoxp-dana")).not.toBeNull();
  });

  it("a failing Slack write shows an honest ❌ line", async () => {
    await seedWorkspace(deps);
    deps.slack.failNext.setUserStatus = "ratelimited";
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    await flush(deps);
    expect(JSON.stringify(deps.slack.responses[0]?.blocks)).toContain(
      "❌ Slack status didn't go through — setUserStatus: ratelimited",
    );
  });

  async function corruptToken() {
    await deps.db
      .update(schema.people)
      .set({ userTokenSealed: "not-a-sealed-token" })
      .where(eq(schema.people.id, "T1:U_DANA"));
  }

  it("a save that throws is reported honestly", async () => {
    await seedWorkspace(deps);
    await corruptToken();
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(1);
    expect(deps.slack.responses[0]?.text).toMatch(/^Your status didn't save — /);
    expect(deps.slack.statuses.size).toBe(0);
  });

  it("a lost receipt after a successful save says nothing misleading", async () => {
    await seedWorkspace(deps);
    deps.slack.failNext.respond = "http_500";
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    await expect(flush(deps)).resolves.toBeUndefined();
    expect(deps.slack.statuses.get("xoxp-dana")).toBeTruthy();
    expect(deps.slack.responses.some((r) => r.text?.includes("didn't save"))).toBe(false);
  });

  it("an undo that throws is reported honestly", async () => {
    await seedWorkspace(deps);
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    await flush(deps);
    const saved = deps.slack.statuses.get("xoxp-dana");
    const statusId = undoValue(deps.slack.responses[0]?.blocks ?? []);
    expect(statusId).toBeTruthy();
    await corruptToken();
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U_DANA", username: "dana" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    });
    await flush(deps);
    expect(deps.slack.responses.at(-1)?.text).toMatch(/^Undo didn't go through — /);
    expect(deps.slack.statuses.get("xoxp-dana")).toEqual(saved);
  });
});
