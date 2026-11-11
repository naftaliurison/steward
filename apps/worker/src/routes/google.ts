import {
  emailFromIdToken,
  GOOGLE_SCOPE,
  type GoogleCalendar,
  getPerson,
  getWorkspace,
  seal,
  upsertGoogleConnection,
} from "@steward/core";
import { type Context, Hono } from "hono";
import type { Deps } from "../deps";
import { signGoogleState, verifyGoogleState } from "../google/state";
import { googleConfigured } from "../registry";
import { escapeHtml } from "./oauth";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const NOT_SET_UP = "Google isn't set up for this Steward yet.";
const EXPIRED = "This link has expired. Run /ooo google in Slack for a new one.";
const NOT_COMPLETED =
  "Google didn't complete the connection. Run /ooo google in Slack to try again.";
const NO_LASTING_ACCESS =
  "Google didn't give Steward lasting access. Run /ooo google in Slack and try again.";

/** A small page. `title` and every paragraph are already safe HTML. */
function page(title: string, ...paragraphs: string[]): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("")}`;
}

export function googleRoutes(deps: Deps) {
  const r = new Hono();
  const redirectUri = `${deps.appUrl}/oauth/google/callback`;
  const nowSeconds = () => Math.floor(deps.now() / 1000);

  // Every answer from these routes is for one person only: never cached.
  r.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  r.use("*", async (c, next) => {
    if (!googleConfigured(deps)) return c.html(page("Google", NOT_SET_UP), 503);
    await next();
  });

  const expired = (c: Context) => c.html(page("Link expired", EXPIRED), 400);

  r.get("/start", async (c) => {
    const personId = await verifyGoogleState(
      deps.signingSecret,
      c.req.query("state") ?? "",
      nowSeconds(),
    );
    if (personId === null) return expired(c);
    const person = await getPerson(deps.db, personId);
    const workspace = person ? await getWorkspace(deps.db, person.workspaceId) : null;
    if (!person || !workspace) return expired(c);
    if (workspace.id.startsWith("demo:")) return expired(c);

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", deps.googleClientId ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "false");
    url.searchParams.set("scope", ["openid", "email", ...Object.values(GOOGLE_SCOPE)].join(" "));
    url.searchParams.set(
      "state",
      await signGoogleState(deps.signingSecret, personId, nowSeconds()),
    );

    const who = person.displayName === "" ? "your Slack account" : escapeHtml(person.displayName);
    return c.html(
      page(
        "Connect Google to Steward",
        `This connects a Google account to ${who} in the Slack workspace ${escapeHtml(workspace.name)}. If that isn't you, close this page.`,
        "Steward will add out-of-office events to your calendar and turn your Gmail auto-reply on and off. It does not read your email.",
        `<a href="${escapeHtml(url.toString())}">Continue to Google</a>`,
      ),
    );
  });

  r.get("/callback", async (c) => {
    if (c.req.query("error")) {
      return c.html(page("Nothing connected", "Nothing was connected. You can close this page."));
    }
    const code = c.req.query("code") ?? "";
    const personId = await verifyGoogleState(
      deps.signingSecret,
      c.req.query("state") ?? "",
      nowSeconds(),
    );
    if (personId === null || code === "") return expired(c);
    const person = await getPerson(deps.db, personId);
    if (!person) return expired(c);
    if (person.workspaceId.startsWith("demo:")) return expired(c);

    const clientId = deps.googleClientId ?? "";
    const clientSecret = deps.googleClientSecret ?? "";
    let tokens: Awaited<ReturnType<Deps["google"]["exchangeCode"]>>;
    let calendars: GoogleCalendar[];
    try {
      tokens = await deps.google.exchangeCode({ clientId, clientSecret, code, redirectUri });
      if (tokens.refreshToken === null) {
        return c.html(page("Not connected", NO_LASTING_ACCESS), 400);
      }
      const listed = await deps.google.listCalendars({ accessToken: tokens.accessToken });
      calendars = listed.map((entry) => ({
        id: entry.id,
        summary: entry.summary,
        primary: entry.primary,
        chosen: entry.primary,
      }));
    } catch {
      // Not logged: the error could carry the code or a token.
      return c.html(page("Not connected", NOT_COMPLETED), 502);
    }

    const now = deps.now();
    await upsertGoogleConnection(deps.db, {
      personId,
      workspaceId: person.workspaceId,
      email: emailFromIdToken(tokens.idToken) ?? "",
      refreshTokenSealed: await seal(deps.tokenKey, tokens.refreshToken),
      accessTokenSealed: await seal(deps.tokenKey, tokens.accessToken),
      accessExpiresAt: now + tokens.expiresInSeconds * 1000,
      scopes: tokens.scope,
      calendars: JSON.stringify(calendars),
      health: "ok",
      connectedAt: now,
      updatedAt: now,
    });

    const granted = tokens.scope.split(" ");
    const notes: string[] = [];
    if (!granted.includes(GOOGLE_SCOPE.gmailSettings)) {
      notes.push(
        "You didn't allow the Gmail auto-reply, so Steward will only add calendar events.",
      );
    }
    if (!granted.includes(GOOGLE_SCOPE.calendarEvents)) {
      notes.push(
        "You didn't allow calendar events, so Steward will only set the Gmail auto-reply.",
      );
    }
    return c.html(
      page(
        "Google is connected",
        "Steward will set your calendar and Gmail auto-reply the next time you run /ooo. You can close this page.",
        ...notes,
      ),
    );
  });

  return r;
}
