import {
  GmailResponderConnector,
  GoogleCalendarConnector,
  SlackStatusConnector,
} from "@steward/availability";
import { ConnectorRegistry, GoogleTokenSource } from "@steward/core";
import type { Deps } from "./deps";

export type RegistryDeps = Pick<
  Deps,
  "db" | "slack" | "google" | "tokenKey" | "now" | "googleClientId" | "googleClientSecret"
>;

/** Whether the owner has set the Google OAuth client. */
export function googleConfigured(
  deps: Pick<Deps, "googleClientId" | "googleClientSecret">,
): boolean {
  return deps.googleClientId !== null && deps.googleClientSecret !== null;
}

/** Every connector this deployment can use. Slack always; Google only when it is configured. */
export function registryFor(deps: RegistryDeps): ConnectorRegistry {
  const registry = new ConnectorRegistry().register(new SlackStatusConnector(deps.slack));
  if (deps.googleClientId === null || deps.googleClientSecret === null) return registry;
  const tokens = new GoogleTokenSource({
    db: deps.db,
    google: deps.google,
    tokenKey: deps.tokenKey,
    clientId: deps.googleClientId,
    clientSecret: deps.googleClientSecret,
    now: deps.now,
  });
  return registry
    .register(new GoogleCalendarConnector({ google: deps.google, tokens }))
    .register(new GmailResponderConnector({ google: deps.google, tokens }));
}
