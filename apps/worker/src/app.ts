import { Hono } from "hono";
import type { Deps } from "./deps";
import { demoRoutes } from "./routes/demo";
import { googleRoutes } from "./routes/google";
import { oauthRoutes } from "./routes/oauth";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/slack", slackRoutes(deps));
  app.route("/oauth/google", googleRoutes(deps));
  app.route("/oauth", oauthRoutes(deps));
  if (deps.demoEnabled) app.route("/demo", demoRoutes(deps));
  else app.all("/demo/*", (c) => c.json({ error: "The demo is switched off." }, 503));
  return app;
}
