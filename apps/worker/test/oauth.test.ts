import { getPerson, getWorkspace, open } from "@steward/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { signState } from "../src/routes/oauth";
import { NOW, SIGNING_SECRET, testDeps } from "./helpers";

describe("Slack install", () => {
  it("redirects to Slack with scopes, redirect_uri and a signed state", async () => {
    const deps = testDeps();
    const res = await createApp(deps).request("/oauth/slack/install");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("commands,chat:write,users:read");
    expect(url.searchParams.get("user_scope")).toBe("users.profile:write");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://steward.example/oauth/slack/callback",
    );
    expect(url.searchParams.get("state")).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it("rejects a callback with a bad or expired state", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    expect((await app.request("/oauth/slack/callback?code=c&state=1.deadbeef")).status).toBe(400);
    const old = await signState(SIGNING_SECRET, Math.floor(NOW / 1000) - 3600);
    expect((await app.request(`/oauth/slack/callback?code=c&state=${old}`)).status).toBe(400);
  });

  it("exchanges the code, stores sealed tokens for the workspace and the installer", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxb-new-bot",
            bot_user_id: "UBOT",
            team: { id: "T9", name: "Acme & Sons" },
            authed_user: { id: "U_OWNER", access_token: "xoxp-owner" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Acme &amp; Sons");

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(call[0]).toBe("https://slack.com/api/oauth.v2.access");
    expect(new URLSearchParams(call[1].body as string).get("code")).toBe("the-code");

    const ws = await getWorkspace(deps.db, "T9");
    expect(ws?.name).toBe("Acme & Sons");
    expect(ws && (await open(deps.tokenKey, ws.botTokenSealed))).toBe("xoxb-new-bot");
    const owner = await getPerson(deps.db, "T9:U_OWNER");
    expect(owner?.userTokenSealed && (await open(deps.tokenKey, owner.userTokenSealed))).toBe(
      "xoxp-owner",
    );
  });

  it("reports Slack's error plainly when the exchange fails", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_code" }), {
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=bad&state=${state}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("invalid_code");
  });

  it("tells the person plainly when they cancelled the install", async () => {
    const deps = testDeps();
    const res = await createApp(deps).request("/oauth/slack/callback?error=access_denied");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Install cancelled");
  });

  it("reports a Slack outage during the exchange as a plain 502, not a crash", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const deps = testDeps({ fetchFn });
    const state = await signState(SIGNING_SECRET, Math.floor(NOW / 1000));
    const res = await createApp(deps).request(`/oauth/slack/callback?code=c&state=${state}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(
      "Slack didn't answer the install request. Try again in a minute.",
    );
  });
});
