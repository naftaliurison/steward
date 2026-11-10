import {
  ensurePerson,
  seal,
  setPersonUserToken,
  slackSignature,
  timingSafeEqual,
  upsertWorkspace,
} from "@steward/core";
import { Hono } from "hono";
import type { Deps } from "../deps";

export const BOT_SCOPES = ["commands", "chat:write", "users:read"];
export const USER_SCOPES = ["users.profile:write"];
const STATE_MAX_AGE_SECONDS = 600;

/** `<issuedAt>.<hmac>` — the HMAC reuses the Slack signing secret so no extra secret is needed. */
export async function signState(secret: string, issuedAtSeconds: number): Promise<string> {
  const mac = await slackSignature(secret, String(issuedAtSeconds), "install");
  return `${issuedAtSeconds}.${mac.slice(3)}`;
}

export async function verifyState(
  secret: string,
  state: string,
  nowSeconds: number,
): Promise<boolean> {
  const [ts, mac] = state.split(".");
  if (!ts || !mac) return false;
  const issued = Number(ts);
  if (
    !Number.isFinite(issued) ||
    nowSeconds - issued > STATE_MAX_AGE_SECONDS ||
    issued > nowSeconds + 60
  )
    return false;
  const expected = (await slackSignature(secret, ts, "install")).slice(3);
  return timingSafeEqual(expected, mac);
}

type AccessResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
  authed_user?: { id: string; access_token?: string };
};

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}

export function oauthRoutes(deps: Deps) {
  const r = new Hono();
  const redirectUri = `${deps.appUrl}/oauth/slack/callback`;

  r.get("/slack/install", async (c) => {
    const state = await signState(deps.signingSecret, Math.floor(deps.now() / 1000));
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", deps.slackClientId);
    url.searchParams.set("scope", BOT_SCOPES.join(","));
    url.searchParams.set("user_scope", USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  r.get("/slack/callback", async (c) => {
    const denied = c.req.query("error");
    if (denied) {
      return c.html(
        `<!doctype html><title>Steward not installed</title><p>Install cancelled (${escapeHtml(denied)}). Nothing was changed.</p>`,
      );
    }
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    if (!code || !(await verifyState(deps.signingSecret, state, Math.floor(deps.now() / 1000)))) {
      return c.text("This install link has expired. Open the install link again.", 400);
    }
    let data: AccessResponse;
    try {
      const res = await deps.fetchFn("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: deps.slackClientId,
          client_secret: deps.slackClientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });
      data = (await res.json()) as AccessResponse;
    } catch (err) {
      console.error("oauth.v2.access failed", { err });
      return c.text("Slack didn't answer the install request. Try again in a minute.", 502);
    }
    if (!data.ok || !data.access_token || !data.team || !data.bot_user_id) {
      return c.text(`Slack didn't complete the install (${data.error ?? "unknown_error"}).`, 502);
    }
    await upsertWorkspace(deps.db, {
      id: data.team.id,
      name: data.team.name,
      botTokenSealed: await seal(deps.tokenKey, data.access_token),
      botUserId: data.bot_user_id,
      installedAt: deps.now(),
    });
    if (data.authed_user) {
      const person = await ensurePerson(
        deps.db,
        data.team.id,
        data.authed_user.id,
        data.authed_user.id,
      );
      if (data.authed_user.access_token) {
        await setPersonUserToken(
          deps.db,
          person.id,
          await seal(deps.tokenKey, data.authed_user.access_token),
        );
      }
    }
    return c.html(
      `<!doctype html><title>Steward installed</title><p>Steward is installed in <b>${escapeHtml(data.team.name)}</b>. Back in Slack, type <code>/ooo</code>.</p>`,
    );
  });

  return r;
}
