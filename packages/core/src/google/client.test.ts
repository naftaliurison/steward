import { describe, expect, it, vi } from "vitest";
import { emailFromIdToken, GoogleApiError, RealGoogleClient } from "./client";

type Call = [string, RequestInit];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientAnswering(...answers: Response[]) {
  const fetchFn = vi.fn(async () => answers.shift() ?? json({}, 500));
  const client = new RealGoogleClient(fetchFn as unknown as typeof fetch);
  const call = (n = 0) => fetchFn.mock.calls[n] as unknown as Call;
  return { client, call };
}

describe("RealGoogleClient", () => {
  it("exchanges a code for tokens", async () => {
    const { client, call } = clientAnswering(
      json({
        access_token: "ya29.a",
        expires_in: 3599,
        refresh_token: "1//r",
        scope: "openid email",
        id_token: "x.y.z",
      }),
    );
    const tokens = await client.exchangeCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "the-code",
      redirectUri: "https://steward.example/oauth/google/callback",
    });
    expect(tokens).toEqual({
      accessToken: "ya29.a",
      expiresInSeconds: 3599,
      refreshToken: "1//r",
      scope: "openid email",
      idToken: "x.y.z",
    });
    const [url, init] = call();
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe("https://steward.example/oauth/google/callback");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refreshes, and names Google's reason when the refresh token is no longer good", async () => {
    const { client, call } = clientAnswering(
      json({ access_token: "ya29.b", expires_in: 3600 }),
      json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        400,
      ),
    );
    const creds = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "1//r" };
    expect(await client.refreshAccessToken(creds)).toEqual({
      accessToken: "ya29.b",
      expiresInSeconds: 3600,
    });
    expect(new URLSearchParams(call()[1].body as string).get("grant_type")).toBe("refresh_token");
    const err = await client.refreshAccessToken(creds).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_grant" });
    expect((err as Error).message).toBe("token.refresh: invalid_grant");
  });

  it("lists the calendars the person can write to", async () => {
    const { client, call } = clientAnswering(
      json({
        items: [
          { id: "dana@example.com", summary: "dana@example.com", primary: true },
          { id: "team@group.calendar.google.com", summary: "Team", summaryOverride: "Our team" },
        ],
      }),
    );
    expect(await client.listCalendars({ accessToken: "ya29.a" })).toEqual([
      { id: "dana@example.com", summary: "dana@example.com", primary: true },
      { id: "team@group.calendar.google.com", summary: "Our team", primary: false },
    ]);
    const [url, init] = call();
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer&maxResults=250",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ya29.a");
  });

  it("inserts an event and reports Google's reason on a refusal", async () => {
    const event = {
      id: "st0abc",
      summary: "Out of office",
      start: { date: "2026-11-12" },
      end: { date: "2026-11-18" },
      transparency: "opaque" as const,
    };
    const { client, call } = clientAnswering(
      json({ id: "st0abc" }),
      json(
        { error: { code: 409, status: "ALREADY_EXISTS", errors: [{ reason: "duplicate" }] } },
        409,
      ),
    );
    const args = { accessToken: "ya29.a", calendarId: "team@group.calendar.google.com", event };
    expect(await client.insertEvent(args)).toEqual({ id: "st0abc" });
    const [url, init] = call();
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(event);
    await expect(client.insertEvent(args)).rejects.toMatchObject({
      status: 409,
      code: "duplicate",
    });
  });

  it("treats an event that is already gone as deleted", async () => {
    const { client, call } = clientAnswering(new Response(null, { status: 410 }));
    await client.deleteEvent({ accessToken: "ya29.a", calendarId: "primary", eventId: "st0abc" });
    expect(call()[0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/st0abc",
    );
    expect(call()[1].method).toBe("DELETE");
  });

  it("reads and writes the Gmail auto-reply", async () => {
    const { client, call } = clientAnswering(
      json({
        enableAutoReply: true,
        responseSubject: "Away",
        responseBodyPlainText: "Back soon",
        startTime: "1000",
        endTime: "2000",
      }),
      json({}),
      json({}),
    );
    expect(await client.getVacation({ accessToken: "ya29.a" })).toEqual({
      enableAutoReply: true,
      responseSubject: "Away",
      responseBodyPlainText: "Back soon",
      startTime: 1000,
      endTime: 2000,
      restrictToContacts: false,
      restrictToDomain: false,
    });
    expect(call()[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation");
    await client.setVacation({
      accessToken: "ya29.a",
      settings: {
        enableAutoReply: true,
        responseSubject: "Out of office",
        responseBodyPlainText: "Hello",
        startTime: 1000,
        endTime: 2000,
        restrictToContacts: false,
        restrictToDomain: false,
      },
    });
    expect(call(1)[1].method).toBe("PUT");
    expect(JSON.parse(call(1)[1].body as string)).toEqual({
      enableAutoReply: true,
      responseSubject: "Out of office",
      responseBodyPlainText: "Hello",
      restrictToContacts: false,
      restrictToDomain: false,
      startTime: "1000",
      endTime: "2000",
    });
    await client.setVacation({
      accessToken: "ya29.a",
      settings: {
        enableAutoReply: false,
        responseSubject: "",
        responseBodyPlainText: "",
        startTime: null,
        endTime: null,
        restrictToContacts: false,
        restrictToDomain: false,
      },
    });
    expect(JSON.parse(call(2)[1].body as string)).not.toHaveProperty("startTime");
  });

  it("gives an empty auto-reply when Gmail sends no fields", async () => {
    const { client } = clientAnswering(json({}));
    expect(await client.getVacation({ accessToken: "ya29.a" })).toEqual({
      enableAutoReply: false,
      responseSubject: "",
      responseBodyPlainText: "",
      startTime: null,
      endTime: null,
      restrictToContacts: false,
      restrictToDomain: false,
    });
  });

  it("reads the person's own restrict-to-contacts setting", async () => {
    const { client } = clientAnswering(json({ enableAutoReply: true, restrictToContacts: true }));
    expect(await client.getVacation({ accessToken: "ya29.a" })).toMatchObject({
      restrictToContacts: true,
      restrictToDomain: false,
    });
  });

  it("sends the restrict settings as given", async () => {
    const { client, call } = clientAnswering(json({}));
    await client.setVacation({
      accessToken: "ya29.a",
      settings: {
        enableAutoReply: true,
        responseSubject: "s",
        responseBodyPlainText: "b",
        startTime: 1,
        endTime: 2,
        restrictToContacts: true,
        restrictToDomain: true,
      },
    });
    expect(JSON.parse(call()[1].body as string)).toMatchObject({
      restrictToContacts: true,
      restrictToDomain: true,
    });
  });

  it("revokes a token and does not mind one that is already revoked", async () => {
    const { client, call } = clientAnswering(json({ error: "invalid_token" }, 400));
    await client.revokeToken({ token: "1//r" });
    expect(call()[0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(call()[1].body as string).get("token")).toBe("1//r");
  });

  it("turns an answer that is not JSON into a typed error", async () => {
    const { client } = clientAnswering(new Response("<html>oops</html>", { status: 502 }));
    await expect(client.listCalendars({ accessToken: "ya29.a" })).rejects.toMatchObject({
      status: 502,
      code: "http_502",
    });
  });

  it("never calls fetch as a method of the client", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(json({ items: [] }));
    });
    try {
      await new RealGoogleClient().listCalendars({ accessToken: "ya29.a" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
  });
});

describe("emailFromIdToken", () => {
  const token = (claims: unknown) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

  it("reads the email claim", () => {
    expect(emailFromIdToken(token({ email: "dana@example.com", sub: "1" }))).toBe(
      "dana@example.com",
    );
  });

  it("answers null for anything else", () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken("not-a-token")).toBeNull();
    expect(emailFromIdToken(token({ sub: "1" }))).toBeNull();
    expect(emailFromIdToken("h.@@@.s")).toBeNull();
  });
});
