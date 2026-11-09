import { Hono } from "hono";
import type { Deps } from "./deps";
import { demoRoutes } from "./routes/demo";
import { oauthRoutes } from "./routes/oauth";
import { slackRoutes } from "./routes/slack";

export function createApp(deps: Deps) {
  const app = new Hono();
  // `slack` tells the product page whether to offer "Add to Slack": every secret the install flow needs is present.
  app.get("/health", (c) =>
    c.json({
      ok: true,
      slack: Boolean(
        deps.slackClientId &&
          deps.slackClientSecret &&
          deps.signingSecret &&
          deps.tokenKey &&
          deps.appUrl,
      ),
    }),
  );
  app.route("/slack", slackRoutes(deps));
  app.route("/oauth", oauthRoutes(deps));
  if (deps.demoEnabled) app.route("/demo", demoRoutes(deps));
  else app.all("/demo/*", (c) => c.json({ error: "The demo is switched off." }, 503));
  return app;
}
