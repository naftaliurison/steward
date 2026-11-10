import { calendarsOf, GOOGLE_SCOPE, getGoogleConnection, open, schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createDemoSession } from "../src/demo/session";
import { signGoogleState, verifyGoogleState } from "../src/google/state";
import { NOW, SIGNING_SECRET, seedWorkspace, type TestDeps, testDeps } from "./helpers";

const PERSON = "T1:U_DANA";
const CODE = "4/the-auth-code";
const EXPIRED = "This link has expired. Run /ooo google in Slack for a new one.";
const NOT_SET_UP = "Google isn't set up for this Steward yet.";
const ALL_SCOPES = ["openid", "email", ...Object.values(GOOGLE_SCOPE)].join(" ");

function idToken(email: string): string {
  const part = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part({ email })}.sig`;
}

const nowSeconds = Math.floor(NOW / 1000);
const goodState = () => signGoogleState(SIGNING_SECRET, PERSON, nowSeconds);

function linkOf(html: string): URL {
  const href = /href="([^"]+)"/.exec(html)?.[1] ?? "";
  return new URL(href.replace(/&amp;/g, "&"));
}

describe("Connect Google", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    deps = testDeps();
    app = createApp(deps);
    await seedWorkspace(deps);
    deps.google.tokens = {
      accessToken: "ya29.new-access",
      expiresInSeconds: 3600,
      refreshToken: "1//new-refresh",
      scope: ALL_SCOPES,
      idToken: idToken("dana@example.com"),
    };
    deps.google.calendars = [
      { id: "dana@example.com", summary: "Dana", primary: true },
      { id: "team@example.com", summary: "Team", primary: false },
    ];
  });

  const callback = async (state?: string) =>
    app.request(`/oauth/google/callback?code=${CODE}&state=${state ?? (await goodState())}`);

  describe("GET /start", () => {
    it("names who is connecting and links to Google with a fresh state", async () => {
      const res = await app.request(`/oauth/google/start?state=${await goodState()}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Connect Google to Steward");
      expect(html).toContain(
        "This connects a Google account to dana in the Slack workspace Acme. If that isn't you, close this page.",
      );
      expect(html).toContain(
        "Steward will add out-of-office events to your calendar and turn your Gmail auto-reply on and off. It does not read your email.",
      );
      expect(html).toContain("Continue to Google");
      const url = linkOf(html);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe("google-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "https://steward.example/oauth/google/callback",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("false");
      expect(url.searchParams.get("scope")).toBe(ALL_SCOPES);
      const state = url.searchParams.get("state") ?? "";
      expect(await verifyGoogleState(SIGNING_SECRET, state, nowSeconds)).toBe(PERSON);
    });

    it("signs the new state at the time the page is opened", async () => {
      const old = await signGoogleState(SIGNING_SECRET, PERSON, nowSeconds - 500);
      deps.clock.now = NOW + 50_000;
      const html = await (await app.request(`/oauth/google/start?state=${old}`)).text();
      const state = linkOf(html).searchParams.get("state") ?? "";
      expect(await verifyGoogleState(SIGNING_SECRET, state, nowSeconds + 50 + 590)).toBe(PERSON);
    });

    it("escapes a name that came from outside", async () => {
      await deps.db
        .update(schema.people)
        .set({ displayName: "<script>alert(1)</script>" })
        .where(eq(schema.people.id, PERSON));
      const res = await app.request(`/oauth/google/start?state=${await goodState()}`);
      const html = await res.text();
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>");
    });

    it("says your Slack account when the person has no name", async () => {
      await deps.db
        .update(schema.people)
        .set({ displayName: "" })
        .where(eq(schema.people.id, PERSON));
      const res = await app.request(`/oauth/google/start?state=${await goodState()}`);
      expect(await res.text()).toContain("to your Slack account in the Slack workspace Acme");
    });

    it("answers 400 for an expired state and for a person who does not exist", async () => {
      const old = await signGoogleState(SIGNING_SECRET, PERSON, nowSeconds - 601);
      const nobody = await signGoogleState(SIGNING_SECRET, "T1:U_NOBODY", nowSeconds);
      for (const state of [old, nobody, "garbage", ""]) {
        const res = await app.request(`/oauth/google/start?state=${state}`);
        expect(res.status).toBe(400);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toContain(EXPIRED);
      }
    });

    it("answers 503 when Google is not set up", async () => {
      const off = createApp(testDeps({ googleClientId: null }));
      const res = await off.request(`/oauth/google/start?state=${await goodState()}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain(NOT_SET_UP);
    });
  });

  describe("GET /callback", () => {
    it("stores the connection with sealed tokens and says so", async () => {
      const res = await callback();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Google is connected");
      expect(html).toContain(
        "Steward will set your calendar and Gmail auto-reply the next time you run /ooo. You can close this page.",
      );
      expect(html).not.toContain("You didn't allow");

      const row = await getGoogleConnection(deps.db, PERSON);
      expect(row).not.toBeNull();
      if (!row) return;
      expect(row.workspaceId).toBe("T1");
      expect(row.email).toBe("dana@example.com");
      expect(row.scopes).toBe(ALL_SCOPES);
      expect(row.health).toBe("ok");
      expect(row.connectedAt).toBe(NOW);
      expect(row.updatedAt).toBe(NOW);
      expect(row.accessExpiresAt).toBe(NOW + 3600 * 1000);
      expect(await open(deps.tokenKey, row.refreshTokenSealed)).toBe("1//new-refresh");
      expect(row.accessTokenSealed && (await open(deps.tokenKey, row.accessTokenSealed))).toBe(
        "ya29.new-access",
      );
      const raw = JSON.stringify(row);
      expect(raw).not.toContain("1//new-refresh");
      expect(raw).not.toContain("ya29.new-access");
      expect(calendarsOf(row)).toEqual([
        { id: "dana@example.com", summary: "Dana", primary: true, chosen: true },
        { id: "team@example.com", summary: "Team", primary: false, chosen: false },
      ]);
      expect(deps.google.exchangedCodes).toEqual([CODE]);
    });

    it("gives Google the redirect address and the app's credentials", async () => {
      const seen: unknown[] = [];
      const original = deps.google.exchangeCode.bind(deps.google);
      deps.google.exchangeCode = async (args) => {
        seen.push(args);
        return original(args);
      };
      await callback();
      expect(seen).toEqual([
        {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
          code: CODE,
          redirectUri: "https://steward.example/oauth/google/callback",
        },
      ]);
    });

    it("keeps one row when the person connects again, with the new tokens", async () => {
      await callback();
      deps.clock.now = NOW + 5000;
      deps.google.tokens = {
        ...deps.google.tokens,
        accessToken: "ya29.second",
        refreshToken: "1//second",
      };
      const res = await callback(await signGoogleState(SIGNING_SECRET, PERSON, nowSeconds + 5));
      expect(res.status).toBe(200);
      const rows = await deps.db.select().from(schema.googleConnections);
      expect(rows).toHaveLength(1);
      expect(await open(deps.tokenKey, rows[0]?.refreshTokenSealed ?? "")).toBe("1//second");
      expect(rows[0]?.updatedAt).toBe(NOW + 5000);
    });

    it("stores an empty email when Google gave no ID token", async () => {
      deps.google.tokens = { ...deps.google.tokens, idToken: null };
      await callback();
      expect((await getGoogleConnection(deps.db, PERSON))?.email).toBe("");
    });

    it("says nothing was connected when the person pressed Cancel", async () => {
      const res = await app.request("/oauth/google/callback?error=access_denied");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Nothing was connected. You can close this page.");
      expect(await getGoogleConnection(deps.db, PERSON)).toBeNull();
    });

    it("rejects a bad state or a missing code without calling Google", async () => {
      const bad = await app.request(`/oauth/google/callback?code=${CODE}&state=1.abc.def`);
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain(EXPIRED);
      const old = await signGoogleState(SIGNING_SECRET, PERSON, nowSeconds - 601);
      expect((await callback(old)).status).toBe(400);
      const noCode = await app.request(`/oauth/google/callback?state=${await goodState()}`);
      expect(noCode.status).toBe(400);
      expect(await getGoogleConnection(deps.db, PERSON)).toBeNull();
      expect(deps.google.exchangedCodes).toEqual([]);
    });

    it("rejects a state for a person who does not exist", async () => {
      const res = await callback(await signGoogleState(SIGNING_SECRET, "T1:U_NOBODY", nowSeconds));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(EXPIRED);
      expect(deps.google.exchangedCodes).toEqual([]);
    });

    it("answers 502 and stores nothing when the exchange fails", async () => {
      deps.google.failNext.exchangeCode = { status: 400, code: "invalid_grant" };
      const res = await callback();
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(
        "Google didn't complete the connection. Run /ooo google in Slack to try again.",
      );
      expect(await getGoogleConnection(deps.db, PERSON)).toBeNull();
    });

    it("answers 400 and stores nothing when Google gave no refresh token", async () => {
      deps.google.tokens = { ...deps.google.tokens, refreshToken: null };
      const res = await callback();
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(
        "Google didn't give Steward lasting access. Run /ooo google in Slack and try again.",
      );
      expect(await getGoogleConnection(deps.db, PERSON)).toBeNull();
    });

    it("answers 502 and stores nothing when the calendars cannot be listed", async () => {
      deps.google.failNext.listCalendars = { status: 500, code: "backendError" };
      const res = await callback();
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Google didn't complete the connection.");
      expect(await getGoogleConnection(deps.db, PERSON)).toBeNull();
    });

    it("answers 503 when Google is not set up", async () => {
      const off = createApp(testDeps({ googleClientSecret: null }));
      const state = await goodState();
      const res = await off.request(`/oauth/google/callback?code=${CODE}&state=${state}`);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain(NOT_SET_UP);
    });

    it("warns when the Gmail permission was not granted", async () => {
      deps.google.tokens = {
        ...deps.google.tokens,
        scope: ALL_SCOPES.replace(` ${GOOGLE_SCOPE.gmailSettings}`, ""),
      };
      const html = await (await callback()).text();
      expect(html).toContain(
        "You didn't allow the Gmail auto-reply, so Steward will only add calendar events.",
      );
      expect(html).not.toContain("allow calendar events");
    });

    it("warns when the calendar events permission was not granted", async () => {
      deps.google.tokens = {
        ...deps.google.tokens,
        scope: ALL_SCOPES.replace(` ${GOOGLE_SCOPE.calendarEvents}`, ""),
      };
      const html = await (await callback()).text();
      expect(html).toContain(
        "You didn't allow calendar events, so Steward will only set the Gmail auto-reply.",
      );
      expect(html).not.toContain("allow the Gmail");
    });

    it("never puts a token, the code or the client secret on a page", async () => {
      const pages = [
        await (await callback()).text(),
        await (await app.request(`/oauth/google/start?state=${await goodState()}`)).text(),
      ];
      deps.google.failNext.exchangeCode = { status: 400, code: "invalid_grant" };
      pages.push(await (await callback()).text());
      for (const html of pages) {
        for (const secret of ["ya29.new-access", "1//new-refresh", CODE, "google-client-secret"]) {
          expect(html).not.toContain(secret);
        }
      }
    });
  });

  describe("a demo person", () => {
    it("gets the expired-link page on /start and /callback, and nothing is exchanged or stored", async () => {
      const demo = await createDemoSession(deps, {});
      if ("error" in demo) throw new Error("unexpected busy");
      expect(demo.workspaceId.startsWith("demo:")).toBe(true);
      const state = await signGoogleState(SIGNING_SECRET, demo.youPersonId, nowSeconds);

      const start = await app.request(`/oauth/google/start?state=${state}`);
      expect(start.status).toBe(400);
      expect(await start.text()).toContain(EXPIRED);

      const cb = await app.request(`/oauth/google/callback?code=${CODE}&state=${state}`);
      expect(cb.status).toBe(400);
      expect(await cb.text()).toContain(EXPIRED);

      expect(deps.google.exchangedCodes).toEqual([]);
      expect(await deps.db.select().from(schema.googleConnections)).toHaveLength(0);
      expect(await getGoogleConnection(deps.db, demo.youPersonId)).toBeNull();
    });
  });

  it("still answers the Slack install routes", async () => {
    const res = await app.request("/oauth/slack/install");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://slack.com/oauth/v2/authorize");
  });
});
