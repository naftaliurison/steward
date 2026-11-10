import { nextDay, STATUS_MODAL_CALLBACK, todayIn, UNDO_ACTION } from "@steward/availability";
import { schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  DEMO_MAX_ACTIONS,
  DEMO_MAX_LIVE_SESSIONS,
  DEMO_MAX_SESSIONS_PER_DAY,
} from "../src/demo/session";
import { demoInteractionPayload } from "../src/routes/demo";
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

    const created = await post(app, "/demo/sessions", { tz: "Pacific/Honolulu" });
    expect(created.status).toBe(201);
    const s = (await created.json()) as Created;
    expect(s.you).toMatchObject({ slackUserId: "U_DANA", tz: "Pacific/Honolulu" });

    const cmd = await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    expect(await cmd.json()).toEqual({ text: "" });
    let state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view"]);
    const view = state.events[0]?.payload.view as { callback_id: string; blocks: Blocks };
    expect(view.callback_id).toBe(STATUS_MODAL_CALLBACK);
    const today = todayIn("Pacific/Honolulu", NOW);
    expect(today).toBe("2026-11-11");
    expect(view.blocks[1]?.element?.initial_date).toBe("2026-11-11");

    const saved = await post(app, `/demo/${s.id}/interact`, submission(today, today));
    expect(await saved.json()).toEqual({ response_action: "clear" });
    state = await getState(app, s.id);
    expect(state.events.map((e) => e.kind)).toEqual(["view", "status", "response"]);
    expect(state.events[1]?.payload).toMatchObject({
      slackUserId: "U_DANA",
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
    expect((state.events[4]?.payload as { responseUrl: string } | undefined)?.responseUrl).toBe(
      `https://hooks.slack.com/demo/${s.id}`,
    );
    expect(JSON.stringify(state)).not.toContain("xoxp");
  });

  it("moving the demo clock past the first day starts a scheduled status", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const tomorrow = nextDay(todayIn("UTC", NOW));
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${s.id}/interact`, submission(tomorrow, tomorrow));
    let state = await getState(app, s.id);
    expect(JSON.stringify(state.events.at(-1)?.payload)).toContain("Scheduled · ");
    expect(state.events.some((e) => e.kind === "status")).toBe(false);

    const advanced = await post(app, `/demo/${s.id}/advance`, { minutes: 1440 });
    expect(advanced.status).toBe(200);
    state = await getState(app, s.id);
    const set = state.events.filter((e) => e.kind === "status");
    expect(set).toHaveLength(1);
    expect(JSON.stringify(set[0]?.payload)).toContain("Out of office");
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

  it("accepts JSON only", async () => {
    const app = createApp(testDeps());
    const form = await app.request("/demo/sessions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "tz=UTC",
    });
    expect(form.status).toBe(415);
    expect(await form.json()).toEqual({ error: "Send JSON." });
    const untyped = await app.request("/demo/sessions", { method: "POST", body: "{}" });
    expect(untyped.status).toBe(415);
  });

  it("turns away a visitor who is sending requests too fast, and nobody else", async () => {
    const seen: string[] = [];
    const deps = testDeps({
      demoLimiter: {
        limit: async ({ key }) => {
          seen.push(key);
          return { success: key !== "203.0.113.9" };
        },
      },
    });
    const app = createApp(deps);
    const from = (ip: string) =>
      app.request("/demo/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: "{}",
      });
    const refused = await from("203.0.113.9");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Slow down a little, then try again." });
    expect((await from("198.51.100.7")).status).toBe(201);
    expect(seen).toEqual(["203.0.113.9", "198.51.100.7"]);
    expect(await deps.db.select().from(schema.demoSessions)).toHaveLength(1);
  });

  it("checks the rate limit before the content type: a refused address gets 429, not 415", async () => {
    const deps = testDeps({ demoLimiter: { limit: async () => ({ success: false }) } });
    const res = await createApp(deps).request("/demo/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: "a=b",
    });
    expect(res.status).toBe(429);
  });

  it("lets visitors through when the limiter itself fails", async () => {
    const deps = testDeps({
      demoLimiter: {
        limit: async () => {
          throw new Error("limiter down");
        },
      },
    });
    expect((await post(createApp(deps), "/demo/sessions", {})).status).toBe(201);
  });

  it("turns everyone away with its own sentence when all demo traffic together is too much", async () => {
    const keys: string[] = [];
    const deps = testDeps({
      demoGlobalLimiter: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const res = await post(createApp(deps), "/demo/sessions", {});
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "The demo is busy right now. Try again in a minute.",
    });
    expect(keys).toEqual(["all"]);
    expect(await deps.db.select().from(schema.demoSessions)).toHaveLength(0);
  });

  it("lets visitors through when the global limiter itself fails", async () => {
    const deps = testDeps({
      demoGlobalLimiter: {
        limit: async () => {
          throw new Error("limiter down");
        },
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await post(createApp(deps), "/demo/sessions", {})).status).toBe(201);
    } finally {
      errors.mockRestore();
    }
  });

  it("the per-visitor refusal wins when both limiters would refuse, and the global one is not asked", async () => {
    let asked = false;
    const deps = testDeps({
      demoLimiter: { limit: async () => ({ success: false }) },
      demoGlobalLimiter: {
        limit: async () => {
          asked = true;
          return { success: false };
        },
      },
    });
    const res = await post(createApp(deps), "/demo/sessions", {});
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Slow down a little, then try again." });
    expect(asked).toBe(false);
  });

  it("answers a full demo and a spent day with different sentences", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const day = new Date(NOW).toISOString().slice(0, 10);
    await deps.db.insert(schema.demoDays).values({ day, sessions: DEMO_MAX_SESSIONS_PER_DAY });
    const closed = await post(app, "/demo/sessions", {});
    expect(closed.status).toBe(429);
    expect(await closed.json()).toEqual({
      error: "The demo has had all its visitors for today. It opens again at midnight UTC.",
    });
    deps.clock.now = NOW + 24 * 60 * 60 * 1000;
    for (let i = 0; i < DEMO_MAX_LIVE_SESSIONS; i++) {
      expect((await post(app, "/demo/sessions", {})).status).toBe(201);
    }
    const full = await post(app, "/demo/sessions", {});
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({
      error: "The demo is full right now. Try again in a few minutes.",
    });
  }, 30_000);

  it("rejects bad input plainly", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    expect((await post(app, `/demo/${s.id}/command`, { text: "/other" })).status).toBe(400);
    expect((await post(app, `/demo/${s.id}/interact`, "not an object")).status).toBe(400);
    for (const body of [
      { type: "view_submission" },
      { type: "view_submission", view: { callback_id: "ooo_status" } },
      { type: "view_submission", view: { callback_id: "ooo_status", state: {} } },
      { type: "block_actions" },
    ]) {
      const res = await post(app, `/demo/${s.id}/interact`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Send a Slack-shaped interaction payload." });
    }
    expect((await post(app, `/demo/${s.id}/advance`, { minutes: "soon" })).status).toBe(400);
  });

  it("refuses a request body over 32 KB and records nothing", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const big = { pad: "x".repeat(40 * 1024) };
    const tooLarge = { error: "That request is too large." };
    const sessionsBefore = await deps.db.select().from(schema.demoSessions);
    const refused = await post(app, "/demo/sessions", big);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual(tooLarge);
    expect(await deps.db.select().from(schema.demoSessions)).toHaveLength(sessionsBefore.length);

    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const res = await post(app, `/demo/${s.id}/interact`, { type: "x", ...big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(tooLarge);
    expect((await getState(app, s.id)).events).toHaveLength(0);
  });

  it("is switched off unless enabled, and creates nothing while off", async () => {
    const deps = testDeps({ demoEnabled: false });
    const app = createApp(deps);
    const off = { error: "The demo is switched off." };
    const created = await post(app, "/demo/sessions", {});
    expect(created.status).toBe(503);
    expect(await created.json()).toEqual(off);
    const state = await app.request("/demo/anything/state");
    expect(state.status).toBe(503);
    expect(await state.json()).toEqual(off);
    expect(await deps.db.select().from(schema.workspaces)).toHaveLength(0);
  });

  it("will not undo another session's status", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const a = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const b = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const today = todayIn("UTC", NOW);
    await post(app, `/demo/${a.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${a.id}/interact`, submission(today, today));
    const stateA = await getState(app, a.id);
    const receipt = stateA.events[2]?.payload as { blocks: Blocks };
    const statusId = undoValue(receipt.blocks);
    expect(statusId).not.toBe("");

    const attempt = await post(app, `/demo/${b.id}/interact`, {
      type: "block_actions",
      actions: [{ action_id: UNDO_ACTION, value: statusId }],
    });
    expect(attempt.status).toBe(200);
    const stateB = await getState(app, b.id);
    expect(stateB.events.map((e) => e.kind)).toEqual(["response"]);
    expect(stateB.events[0]?.payload).toMatchObject({
      text: "That status isn't yours or no longer exists.",
      responseUrl: `https://hooks.slack.com/demo/${b.id}`,
    });

    const targets = await deps.db
      .select()
      .from(schema.statusTargets)
      .where(eq(schema.statusTargets.statusId, statusId));
    expect(targets.map((t) => t.state)).toEqual(["done"]);
    expect((await getState(app, a.id)).events.map((e) => e.kind)).toEqual([
      "view",
      "status",
      "response",
    ]);
  });

  it("gives every /command its own trigger id", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    await post(app, `/demo/${s.id}/command`, { text: "/ooo" });
    const views = (await getState(app, s.id)).events.filter((e) => e.kind === "view");
    const ids = views.map((e) => e.payload.triggerId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("takes whole minutes from 1 to 1440 and refuses everything else", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const s = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const msg = { error: "Send { minutes: a whole number from 1 to 1440 }." };
    for (const minutes of [0, 0.5, -5, 1441, "5", null, Number.NaN]) {
      const res = await post(app, `/demo/${s.id}/advance`, { minutes });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(msg);
    }
    expect((await post(app, `/demo/${s.id}/advance`, {})).status).toBe(400);
    const one = await post(app, `/demo/${s.id}/advance`, { minutes: 1 });
    expect(one.status).toBe(200);
    expect(((await one.json()) as State).now).toBe(NOW + 60 * 1000);
    const edge = await post(app, `/demo/${s.id}/advance`, { minutes: 1440 });
    expect(edge.status).toBe(200);
    expect(((await edge.json()) as State).now).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it("ignores a visitor time zone it does not know", async () => {
    const app = createApp(testDeps());
    for (const tz of ["Mars/Olympus", 42]) {
      const res = await post(app, "/demo/sessions", { tz });
      expect(res.status).toBe(201);
      expect(((await res.json()) as Created).you.tz).toBe("UTC");
    }
  });

  const SPENT = { error: "This demo session has done all it can. Start over to continue." };

  it("gives a session exactly its budget of actions when requests race", async () => {
    const app = createApp(testDeps());
    const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    const answers = await Promise.all(
      Array.from({ length: DEMO_MAX_ACTIONS + 10 }, () =>
        post(app, `/demo/${id}/command`, { text: "/ooo" }),
      ),
    );
    expect(answers.filter((r) => r.status === 200)).toHaveLength(DEMO_MAX_ACTIONS);
    const refused = answers.filter((r) => r.status === 409);
    expect(refused).toHaveLength(10);
    for (const r of refused) expect(await r.json()).toEqual(SPENT);
    expect((await getState(app, id)).events).toHaveLength(DEMO_MAX_ACTIONS);
  });

  it("a spent session refuses interact and advance too, and still shows its state", async () => {
    const app = createApp(testDeps());
    const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    for (let i = 0; i < DEMO_MAX_ACTIONS; i++) {
      expect((await post(app, `/demo/${id}/advance`, { minutes: 1 })).status).toBe(200);
    }
    const today = todayIn("UTC", NOW);
    const interact = await post(app, `/demo/${id}/interact`, submission(today, today));
    expect(interact.status).toBe(409);
    expect(await interact.json()).toEqual(SPENT);
    const advance = await post(app, `/demo/${id}/advance`, { minutes: 1 });
    expect(advance.status).toBe(409);
    expect(await advance.json()).toEqual(SPENT);
    const command = await post(app, `/demo/${id}/command`, { text: "/ooo" });
    expect(command.status).toBe(409);
    const state = await app.request(`/demo/${id}/state`);
    expect(state.status).toBe(200);
    expect(((await state.json()) as State).now).toBe(NOW + DEMO_MAX_ACTIONS * 60 * 1000);
  });

  it("does not spend an action on a request it refuses for its shape", async () => {
    const app = createApp(testDeps());
    const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    for (let i = 0; i < DEMO_MAX_ACTIONS + 5; i++) {
      await post(app, `/demo/${id}/command`, { text: "/other" });
      await post(app, `/demo/${id}/interact`, { type: "block_actions" });
      await post(app, `/demo/${id}/advance`, { minutes: 0 });
    }
    expect((await post(app, `/demo/${id}/command`, { text: "/ooo" })).status).toBe(200);
  });

  it("says so when the clock cannot go further", async () => {
    const app = createApp(testDeps());
    const { id } = (await (await post(app, "/demo/sessions", {})).json()) as Created;
    expect((await post(app, `/demo/${id}/advance`, { minutes: 1440 })).status).toBe(200);
    const more = await post(app, `/demo/${id}/advance`, { minutes: 5 });
    expect(more.status).toBe(400);
    expect(await more.json()).toEqual({
      error: "The demo clock is already a day ahead. Start over to rewind it.",
    });
  });
});

describe("demoInteractionPayload", () => {
  const session = { id: "S1", workspaceId: "W1" };
  const you = { slackUserId: "U_DANA", displayName: "dana" };
  const mine = JSON.stringify({ responseUrl: "https://hooks.slack.com/demo/S1" });
  const evil = JSON.stringify({ responseUrl: "https://evil.example/x" });

  it.each(["view_submission", "view_closed", "block_actions"])(
    "overwrites private_metadata for %s",
    (type) => {
      const out = demoInteractionPayload({ type, view: { private_metadata: evil } }, session, you);
      expect((out.view as { private_metadata: string }).private_metadata).toBe(mine);
    },
  );

  it("leaves a non-object view alone", () => {
    expect(demoInteractionPayload({ type: "x", view: "plain" }, session, you).view).toBe("plain");
    expect(demoInteractionPayload({ type: "x" }, session, you)).not.toHaveProperty("view");
  });

  it("always sets team, user and response_url from the session", () => {
    const out = demoInteractionPayload(
      { type: "x", team: { id: "T" }, user: { id: "U" }, response_url: "https://evil.example/x" },
      session,
      you,
    );
    expect(out).toMatchObject({
      team: { id: "W1" },
      user: { id: "U_DANA", username: "dana" },
      response_url: "https://hooks.slack.com/demo/S1",
    });
  });

  it("gives a button press its own response URL, named after the message it lives on", () => {
    const base = `https://hooks.slack.com/demo/${session.id}`;
    const url = (container: unknown) =>
      demoInteractionPayload({ type: "block_actions", container }, session, null).response_url;
    expect(url({ type: "message", message_ts: "3" })).toBe(`${base}/3`);
    expect(url({ type: "message", message_ts: "3/../../evil" })).toBe(base);
    expect(url({ type: "message", message_ts: "12345678901" })).toBe(base);
    expect(url({ type: "message", message_ts: 3 })).toBe(base);
    expect(url(undefined)).toBe(base);
  });
});
