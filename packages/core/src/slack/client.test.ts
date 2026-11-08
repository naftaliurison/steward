import { describe, expect, it, vi } from "vitest";
import { header } from "./blocks";
import { RealSlackClient, SlackApiError } from "./client";

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("RealSlackClient", () => {
  it("opens a view with the bot token and returns the view id", async () => {
    const fetchFn = fetchReturning({ ok: true, view: { id: "V123" } });
    const slack = new RealSlackClient(fetchFn);
    const result = await slack.openView({
      botToken: "xoxb-1",
      triggerId: "trig",
      view: {
        type: "modal",
        callback_id: "cb",
        title: { type: "plain_text", text: "t" },
        blocks: [header("h")],
      },
    });
    expect(result.viewId).toBe("V123");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/views.open");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body as string).trigger_id).toBe("trig");
  });

  it("sets a user status with the user token", async () => {
    const fetchFn = fetchReturning({ ok: true });
    const slack = new RealSlackClient(fetchFn);
    await slack.setUserStatus({
      userToken: "xoxp-1",
      text: "Out",
      emoji: ":palm_tree:",
      expiration: 1700000000,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/users.profile.set");
    expect(JSON.parse(init.body as string)).toEqual({
      profile: { status_text: "Out", status_emoji: ":palm_tree:", status_expiration: 1700000000 },
    });
  });

  it("throws SlackApiError with Slack's error code", async () => {
    const slack = new RealSlackClient(fetchReturning({ ok: false, error: "invalid_auth" }));
    await expect(slack.clearUserStatus({ userToken: "bad" })).rejects.toEqual(
      new SlackApiError("users.profile.set", "invalid_auth"),
    );
  });

  it("posts to a response_url and fails on a non-2xx", async () => {
    const ok = new RealSlackClient(fetchReturning({}, 200));
    await expect(
      ok.respond({ responseUrl: "https://hooks.slack.com/x", text: "hi" }),
    ).resolves.toBeUndefined();
    const bad = new RealSlackClient(fetchReturning({}, 500));
    await expect(
      bad.respond({ responseUrl: "https://hooks.slack.com/x", text: "hi" }),
    ).rejects.toEqual(new SlackApiError("response_url", "http_500"));
  });

  it("reads a user's display name and time zone with the bot token", async () => {
    const fetchFn = fetchReturning({
      ok: true,
      user: {
        name: "dana",
        real_name: "Dana Levi",
        tz: "Asia/Jerusalem",
        profile: { display_name: "Dana" },
      },
    });
    const slack = new RealSlackClient(fetchFn);
    expect(await slack.getUserInfo({ botToken: "xoxb-1", userId: "U1" })).toEqual({
      displayName: "Dana",
      tz: "Asia/Jerusalem",
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/users.info?user=U1");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-1");
  });

  it("returns null for an unknown user and falls back to the id and a null time zone when fields are missing", async () => {
    const unknown = new RealSlackClient(fetchReturning({ ok: false, error: "user_not_found" }));
    expect(await unknown.getUserInfo({ botToken: "x", userId: "U9" })).toBeNull();
    const bare = new RealSlackClient(fetchReturning({ ok: true, user: {} }));
    expect(await bare.getUserInfo({ botToken: "x", userId: "U9" })).toEqual({
      displayName: "U9",
      tz: null,
    });
  });

  it("turns a non-JSON reply into a typed error instead of a SyntaxError", async () => {
    const fetchFn = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(new RealSlackClient(fetchFn).clearUserStatus({ userToken: "t" })).rejects.toEqual(
      new SlackApiError("users.profile.set", "http_502"),
    );
  });

  it("refuses to post a receipt anywhere but hooks.slack.com", async () => {
    const fetchFn = fetchReturning({}, 200);
    const slack = new RealSlackClient(fetchFn);
    await expect(
      slack.respond({ responseUrl: "https://evil.example/x", text: "hi" }),
    ).rejects.toEqual(new SlackApiError("response_url", "untrusted_url"));
    await expect(
      slack.respond({ responseUrl: "http://hooks.slack.com/x", text: "hi" }),
    ).rejects.toEqual(new SlackApiError("response_url", "untrusted_url"));
    for (const responseUrl of ["https://hooks.slack.com:8443/x", "https://u:p@hooks.slack.com/x"]) {
      await expect(slack.respond({ responseUrl, text: "hi" })).rejects.toEqual(
        new SlackApiError("response_url", "untrusted_url"),
      );
    }
    await expect(slack.respond({ responseUrl: "not a url", text: "hi" })).rejects.toEqual(
      new SlackApiError("response_url", "untrusted_url"),
    );
    expect(fetchFn.mock.calls).toHaveLength(0);
  });
});
