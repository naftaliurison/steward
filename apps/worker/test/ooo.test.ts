import {
  GOOGLE_HINT,
  STATUS_MODAL_CALLBACK,
  UNDO_ACTION,
  zonedTimeToEpochMs,
} from "@steward/availability";
import {
  type Block,
  ensurePerson,
  schema,
  seal,
  setPersonUserToken,
  upsertWorkspace,
} from "@steward/core";
import { seedGoogleConnection } from "@steward/core/testing";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { LOOKUP_FAILED, SAVE_FAILED, UNDO_FAILED } from "../src/routes/slack";
import { flush, NOW, seedWorkspace, slackPost, type TestDeps, TZ, testDeps } from "./helpers";

const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/r1";

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

  it("/ooo also shows the statuses that are scheduled, each with its own Cancel", async () => {
    await seedWorkspace(deps);
    for (const day of ["2026-11-20", "2026-11-13"]) {
      await slackPost(app, "/slack/interactions", {
        payload: JSON.stringify(submission({ type: "out", from: day, to: day })),
      });
      await flush(deps);
    }
    deps.slack.responses.length = 0;

    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "trig-2",
      response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(2);
    expect(deps.slack.responses[0]?.text).toMatch(/^Scheduled · Out of office · /);
    expect(deps.slack.responses[1]?.text).toMatch(/^Scheduled · Out of office · /);
    // Earliest first: the two cards are for different statuses, the 13th before the 20th.
    const [first, second] = deps.slack.responses.map((r) => undoValue(r.blocks ?? []));
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const rows = await deps.db.select().from(schema.statuses);
    const startOf = (id: string | undefined) => rows.find((r) => r.id === id)?.startMs ?? 0;
    expect(startOf(first)).toBeLessThan(startOf(second));
  });

  it("/ooo sends nothing extra when nothing is scheduled", async () => {
    await seedWorkspace(deps);
    await slackPost(app, "/slack/commands", {
      command: "/ooo",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "trig-3",
      response_url: RESPONSE_URL,
    });
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(0);
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

  it("saves a future first day as scheduled: Slack untouched, the receipt offers Cancel, Cancel calls it off", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-13", to: "2026-11-14" })),
    });
    expect(res.status).toBe(200);
    await flush(deps);
    const receipt = deps.slack.responses[0];
    expect(receipt?.text).toMatch(/^Scheduled · Out of office · /);
    expect(deps.slack.statuses.size).toBe(0);
    const statusId = undoValue(receipt?.blocks ?? []);
    expect(statusId).toBeTruthy();

    const cancel = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U_DANA", username: "dana" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: UNDO_ACTION, value: statusId }],
      }),
    });
    expect(cancel.status).toBe(200);
    await flush(deps);
    expect(deps.slack.responses[1]?.replaceOriginal).toBe(true);
    expect(deps.slack.responses[1]?.text).toMatch(/^Cancelled · Out of office/);
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
    expect(deps.slack.responses[0]?.text).toBe(SAVE_FAILED);
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
    expect(deps.slack.responses.at(-1)?.text).toBe(UNDO_FAILED);
    expect(deps.slack.statuses.get("xoxp-dana")).toEqual(saved);
  });

  it("answers 200, not 500, to a signed view_submission with no view", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        type: "view_submission",
        team: { id: "T1" },
        user: { id: "U_DANA" },
      }),
    });
    expect(res.status).toBe(200);
    expect(deps.deferred).toHaveLength(0);
  });

  it("ignores a malformed interaction payload with a 200 and no work", async () => {
    await seedWorkspace(deps);
    const res = await slackPost(app, "/slack/interactions", { payload: "not json" });
    expect(res.status).toBe(200);
    expect(deps.deferred).toHaveLength(0);
    for (const payload of [
      JSON.stringify({ type: "x" }),
      JSON.stringify({ type: "view_submission", team: { id: "T1" } }),
      "null",
      '"x"',
    ]) {
      const bad = await slackPost(app, "/slack/interactions", { payload });
      expect(bad.status).toBe(200);
    }
    expect(deps.deferred).toHaveLength(0);
    expect(deps.slack.openedViews).toHaveLength(0);
    expect(deps.slack.responses).toHaveLength(0);
  });

  it("answers /ooo plainly when the form can't be opened", async () => {
    await seedWorkspace(deps);
    deps.slack.failNext.openView = "expired_trigger_id";
    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo",
      text: "",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "t",
      response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      "Steward couldn't open the form just now. Please try /ooo again.",
    );
  });

  it("answers /ooo plainly when the workspace's bot token can't be read", async () => {
    await seedWorkspace(deps);
    await deps.db
      .update(schema.workspaces)
      .set({ botTokenSealed: "not-a-sealed-token" })
      .where(eq(schema.workspaces.id, "T1"));
    const res = await slackPost(app, "/slack/commands", {
      command: "/ooo",
      text: "",
      team_id: "T1",
      user_id: "U_DANA",
      user_name: "dana",
      trigger_id: "t",
      response_url: RESPONSE_URL,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("can't reach Slack for this workspace");
    expect(deps.slack.openedViews).toHaveLength(0);
  });

  it("answers with an inline error when the person lookup fails", async () => {
    await seedWorkspace(deps);
    await deps.db.run(sql`DROP TABLE people`);
    const res = await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
    });
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { type: LOOKUP_FAILED },
    });
    expect(deps.deferred).toHaveLength(0);
  });

  it("validates the dates against the person's today, not UTC's", async () => {
    const LATE = Date.UTC(2026, 10, 12, 22, 30);
    const lateDeps = testDeps({ now: () => LATE });
    const lateApp = createApp(lateDeps);
    await seedWorkspace(lateDeps);

    const today = await slackPost(
      lateApp,
      "/slack/interactions",
      {
        payload: JSON.stringify(submission({ type: "out", from: "2026-11-13", to: "2026-11-13" })),
      },
      LATE,
    );
    expect(await today.json()).toEqual({ response_action: "clear" });
    await flush(lateDeps);

    const past = await slackPost(
      lateApp,
      "/slack/interactions",
      {
        payload: JSON.stringify(submission({ type: "out", from: "2026-11-12", to: "2026-11-12" })),
      },
      LATE,
    );
    expect(await past.json()).toEqual({
      response_action: "errors",
      errors: { to: "The last day has already passed." },
    });
  });
});

describe("/ooo with Google", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createApp>;

  const save = async (type: string) => {
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify(submission({ type, from: "2026-11-12", to: "2026-11-17" })),
    });
    await flush(deps);
    return deps.slack.responses.at(-1);
  };
  const press = async (statusId: string | undefined) => {
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
  };

  beforeEach(() => {
    deps = testDeps();
    app = createApp(deps);
  });

  it("writes a calendar event and turns the auto-reply on for a connected person, and Undo reverses both", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, {
      personId: person.id,
      workspaceId: "T1",
    });
    const receipt = await save("out");
    expect(deps.google.inserts).toHaveLength(1);
    expect(deps.google.vacation.enableAutoReply).toBe(true);
    const card = JSON.stringify(receipt?.blocks);
    expect(card).toContain("Calendar event added");
    expect(card).toContain("Gmail auto-reply on");

    await press(undoValue(receipt?.blocks ?? []));
    expect(deps.google.events.size).toBe(0);
    expect(deps.google.vacation.enableAutoReply).toBe(false);
  });

  it("tells a person without Google how to connect it", async () => {
    await seedWorkspace(deps);
    const receipt = await save("out");
    expect(JSON.stringify(receipt?.blocks)).toContain(GOOGLE_HINT);
    expect(deps.google.inserts).toHaveLength(0);
  });

  it("does not mention Google while the OAuth client is not set", async () => {
    deps = testDeps({ googleClientId: null });
    app = createApp(deps);
    await seedWorkspace(deps);
    const receipt = await save("out");
    expect(JSON.stringify(receipt?.blocks)).not.toContain(GOOGLE_HINT);
  });

  it("does not hint for a status that has nothing to do with Google", async () => {
    await seedWorkspace(deps);
    const receipt = await save("remote");
    expect(JSON.stringify(receipt?.blocks)).not.toContain(GOOGLE_HINT);
  });

  it("never tells a demo visitor to connect Google, though Google is configured", async () => {
    await upsertWorkspace(deps.db, {
      id: "demo:abc",
      name: "Demo",
      botTokenSealed: await seal(deps.tokenKey, "xoxb-bot"),
      botUserId: "UBOT",
      installedAt: NOW - 1000,
    });
    const person = await ensurePerson(deps.db, "demo:abc", "U_DANA", "dana");
    await deps.db
      .update(schema.people)
      .set({ tz: TZ, profileSyncedAt: NOW })
      .where(eq(schema.people.id, person.id));
    await setPersonUserToken(deps.db, person.id, await seal(deps.tokenKey, "xoxp-dana"));
    await slackPost(app, "/slack/interactions", {
      payload: JSON.stringify({
        ...submission({ type: "out", from: "2026-11-12", to: "2026-11-17" }),
        team: { id: "demo:abc" },
      }),
    });
    await flush(deps);
    const receipt = deps.slack.responses.at(-1);
    expect(receipt?.text).toMatch(/^Out of office · /);
    expect(JSON.stringify(receipt?.blocks)).not.toContain(GOOGLE_HINT);
  });
});
