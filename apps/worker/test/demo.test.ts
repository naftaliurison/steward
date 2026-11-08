import { STATUS_MODAL_CALLBACK, todayIn, UNDO_ACTION } from "@steward/availability";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { NOW, testDeps } from "./helpers";

type Created = { id: string; you: { slackUserId: string; tz: string }; expiresAt: number };
type Ev = { seq: number; kind: string; payload: Record<string, unknown> };
type State = { now: number; events: Ev[] };
type Blocks = {
  type: string;
  elements?: { action_id?: string; value?: string }[];
  element?: { initial_date?: string };
}[];

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getState = async (app: ReturnType<typeof createApp>, id: string) =>
  (await (await app.request(`/demo/${id}/state`)).json()) as State;

function submission(from: string, to: string) {
  return {
    type: "view_submission",
    team: { id: "T_SOMEONE_ELSE" },
    user: { id: "U_SOMEONE_ELSE" },
    view: {
      callback_id: STATUS_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ responseUrl: "https://evil.example/x" }),
      state: {
        values: {
          type: { type: { type: "static_select", selected_option: { value: "out" } } },
          from: { from: { type: "datepicker", selected_date: from } },
          to: { to: { type: "datepicker", selected_date: to } },
          text: { text: { type: "plain_text_input", value: null } },
          emoji: { emoji: { type: "plain_text_input", value: null } },
        },
      },
    },
  };
}
const undoValue = (blocks: Blocks) =>
  blocks.find((b) => b.type === "actions")?.elements?.[0]?.value ?? "";

describe("/demo", () => {
  it("runs the whole /ooo flow for a visitor, against the recording Slack, in their own zone", async () => {
    const deps = testDeps();
    const app = createApp(deps);

    const created = await post(app, "/demo/sessions", { tz: "Asia/Tokyo" });
    expect(created.status).toBe(201);
    const s = (await created.json()) as Created;
    expect(s.you).toMatchObject({ slackUserId: "U_DANA", tz: "Asia/Tokyo" });

    const cmd = await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    expect(await cmd.json()).toEqual({ text: "" });
    let state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view"]);
    const view = state.events[0]?.payload.view as { callback_id: string; blocks: Blocks };
    expect(view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    const today = todayIn("Asia/Tokyo", NOW);
    expect(view.blocks[1]?.element?.initial_date).toBe(today);

    const saved = await post(app, `/demo/${s.id}/interact`, submission(today, today));
    expect(await saved.json()).toEqual({ response_action: "clear" });
    state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view", "status", "response"]);
    expect(state.events[1]?.payload).toMatchObject({
      userToken: "xoxp-demo-U_DANA",
      status: { text: "Out of office" },
    });
    const receipt = state.events[2]?.payload as {
      responseUrl: string;
      text: string;
      blocks: Blocks;
    };
    expect(receipt.responseUrl).toBe(`https://hooks.slack.com/demo/${s.id}`);
    expect(receipt.text).toMatch(/^Out of office · /);
    expect(JSON.stringify(receipt.blocks)).toContain("✅ Slack status set");

    const undo = await post(app, `/demo/${s.id}/interact`, {
      type: "block_actions",
      team: { id: "T_X" },
      user: { id: "U_X" },
      response_url: "https://evil.example/x",
      actions: [{ action_id: UNDO_ACTION, value: undoValue(receipt.blocks) }],
    });
    expect(undo.status).toBe(200);
    state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual([
      "view",
      "status",
      "response",
      "status",
      "response",
    ]);
    expect((state.events[3]?.payload as { status: unknown } | undefined)?.status).toBeNull();
    expect((state.events[4]?.payload as { text: string } | undefined)?.text).toMatch(/^Undone · /);
  });

  it("advances time so the undo window closes, and a gone session is a 404", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const today = todayIn("UTC", NOW);
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${s.id}/interact`, submission(today, today));
    const advanced = await post(app, `/demo/${s.id}/advance`, { minutes: 6 });
    expect(((await advanced.json()) as State).now).toBe(NOW + 6 * 60 * 1000);
    let state = await getState(app, s.id);
    const receipt = state.events[2]?.payload as { blocks: Blocks };
    await post(app, `/demo/${s.id}/interact`, {
      type: "block_actions",
      team: { id: "x" },
      user: { id: "x" },
      response_url: "x",
      actions: [{ action_id: UNDO_ACTION, value: undoValue(receipt.blocks) }],
    });
    state = await getState(app, s.id);
    expect((state.events.at(-1)?.payload as { text: string } | undefined)?.text).toBe(
      "The five-minute undo window has passed.",
    );

    deps.clock.now = NOW + 61 * 60 * 1000;
    expect((await app.request(`/demo/${s.id}/state`)).status).toBe(404);
    expect((await post(app, `/demo/${s.id}/command`, { text: "/ooo" })).status).toBe(404);
  });

  it("rejects bad input plainly", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    expect((await post(app, `/demo/${s.id}/command`, { text: "/other" })).status).toBe(400);
    expect((await post(app, `/demo/${s.id}/interact`, "not an object")).status).toBe(400);
    expect((await post(app, `/demo/${s.id}/advance`, { minutes: "soon" })).status).toBe(400);
  });
});
