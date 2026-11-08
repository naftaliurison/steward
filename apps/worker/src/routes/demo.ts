import { getPerson, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  advanceDemoClock,
  createDemoSession,
  type DemoSession,
  demoDeps,
  getDemoSession,
} from "../demo/session";
import { readDemoEvents } from "../demo/slackClient";
import type { Deps } from "../deps";
import { handleInteraction, handleSlashCommand } from "../slack/handlers";

type Vars = { Variables: { session: DemoSession } };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const responseUrlFor = (session: Pick<DemoSession, "id">) =>
  `https://hooks.slack.com/demo/${session.id}`;

/**
 * What the visitor's interaction becomes before it reaches the handlers.
 * The visitor never chooses the workspace, the user, where receipts go, or the
 * modal's private_metadata (which carries a response URL).
 */
export function demoInteractionPayload(
  body: Record<string, unknown>,
  session: Pick<DemoSession, "id" | "workspaceId">,
  you: { slackUserId: string; displayName: string } | null | undefined,
): Record<string, unknown> {
  const url = responseUrlFor(session);
  const payload: Record<string, unknown> = {
    ...body,
    team: { id: session.workspaceId },
    user: { id: you?.slackUserId ?? "U_DANA", username: you?.displayName ?? "you" },
    response_url: url,
  };
  if (isObject(payload.view)) {
    payload.view = { ...payload.view, private_metadata: JSON.stringify({ responseUrl: url }) };
  }
  return payload;
}

async function stateOf(deps: Deps, session: DemoSession) {
  const events = await readDemoEvents(deps.db, session.id);
  return {
    now: deps.now() + session.clockOffsetMs,
    expiresAt: session.expiresAt,
    clockOffsetMs: session.clockOffsetMs,
    events: events.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      at: e.at,
      payload: JSON.parse(e.payload) as unknown,
    })),
  };
}

export function demoRoutes(deps: Deps) {
  const r = new Hono<Vars>();

  r.post("/sessions", async (c) => {
    const body = await readJson(c);
    const visitorTz = isObject(body) && typeof body.tz === "string" ? body.tz : undefined;
    const session = await createDemoSession(deps, { visitorTz });
    if ("error" in session) return c.json({ error: "busy" }, 429);
    const people = await deps.db
      .select()
      .from(schema.people)
      .where(eq(schema.people.workspaceId, session.workspaceId));
    const brief = (p: { slackUserId: string; displayName: string; tz: string }) => ({
      slackUserId: p.slackUserId,
      displayName: p.displayName,
      tz: p.tz,
    });
    const you = people.find((p) => p.id === session.youPersonId);
    return c.json(
      {
        id: session.id,
        expiresAt: session.expiresAt,
        clockOffsetMs: session.clockOffsetMs,
        you: you ? brief(you) : null,
        people: people.map(brief),
      },
      201,
    );
  });

  // Every route below needs a live session.
  r.use("/:id/*", async (c, next) => {
    const session = await getDemoSession(deps, c.req.param("id") ?? "");
    if (!session) return c.json({ error: "gone" }, 404);
    c.set("session", session);
    await next();
  });

  r.get("/:id/state", async (c) => c.json(await stateOf(deps, c.get("session"))));

  r.post("/:id/command", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    const text = isObject(body) && typeof body.text === "string" ? body.text.trim() : "";
    if (!text.startsWith("/ooo"))
      return c.json({ error: "Only /ooo is available in the demo." }, 400);
    const you = await getPerson(deps.db, session.youPersonId);
    const d = demoDeps(deps, session);
    const form = new URLSearchParams({
      command: "/ooo",
      text: text.slice("/ooo".length).trim(),
      team_id: session.workspaceId,
      user_id: you?.slackUserId ?? "U_DANA",
      user_name: you?.displayName ?? "you",
      trigger_id: `demo-${crypto.randomUUID()}`,
      response_url: responseUrlFor(session),
    });
    const answer = await handleSlashCommand(d, form);
    await d.settle();
    return c.json({ text: answer });
  });

  r.post("/:id/interact", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    if (!isObject(body) || typeof body.type !== "string") {
      return c.json({ error: "Send a Slack-shaped interaction payload." }, 400);
    }
    const you = await getPerson(deps.db, session.youPersonId);
    const payload = demoInteractionPayload(body, session, you);
    const d = demoDeps(deps, session);
    const answer = await handleInteraction(d, payload);
    await d.settle();
    return answer.kind === "json" ? c.json(answer.body) : c.text(answer.body);
  });

  r.post("/:id/advance", async (c) => {
    const session = c.get("session");
    const body = await readJson(c);
    const minutes =
      isObject(body) && typeof body.minutes === "number" && Number.isFinite(body.minutes)
        ? body.minutes
        : null;
    if (minutes === null || minutes < 0 || minutes > 1440)
      return c.json({ error: "Send { minutes: number } between 0 and 1440." }, 400);
    const advanced = await advanceDemoClock(deps, session, minutes * 60 * 1000);
    return c.json(await stateOf(deps, advanced));
  });

  return r;
}
