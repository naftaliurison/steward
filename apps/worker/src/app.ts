import { Hono } from "hono";
import type { Deps } from "./deps";
import { demoRoutes } from "./routes/demo";
import { oauthRoutes } from "./routes/oauth";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/slack", slackRoutes(deps));
  app.route("/oauth", oauthRoutes(deps));
  app.route("/demo", demoRoutes(deps));
  return app;
}
