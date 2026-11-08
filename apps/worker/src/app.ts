import { Hono } from "hono";
import type { Deps } from "./deps";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/slack", slackRoutes(deps));
  return app;
}
