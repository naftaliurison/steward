import { verifySlackSignature } from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";
import { handleInteraction, handleSlashCommand } from "../slack/handlers";

export { LOOKUP_FAILED, SAVE_FAILED, UNDO_FAILED } from "../slack/handlers";

type Vars = { Variables: { rawBody: string } };

export function slackRoutes(deps: Deps) {
  const r = new Hono<Vars>();

  // Every Slack request is verified before anything else; the raw body is kept for the handlers.
  r.use("*", async (c, next) => {
    const raw = await c.req.text();
    const ok = await verifySlackSignature({
      secret: deps.signingSecret,
      timestamp: c.req.header("x-slack-request-timestamp") ?? "",
      signature: c.req.header("x-slack-signature") ?? "",
      body: raw,
      nowSeconds: Math.floor(deps.now() / 1000),
    });
    if (!ok) return c.text("invalid signature", 401);
    c.set("rawBody", raw);
    await next();
  });

  r.post("/commands", async (c) => {
    const form = new URLSearchParams(c.get("rawBody"));
    return c.text(await handleSlashCommand(deps, form));
  });

  r.post("/interactions", async (c) => {
    const raw = new URLSearchParams(c.get("rawBody")).get("payload") ?? "";
    const answer = await handleInteraction(deps, raw);
    return answer.kind === "json" ? c.json(answer.body) : c.text(answer.body);
  });

  return r;
}
