import { getGoogleConnection } from "@steward/core";
import { seedGoogleConnection } from "@steward/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyGoogleState } from "../src/google/state";
import { googleCommandOf } from "../src/slack/googleCommand";
import { handleSlashCommand } from "../src/slack/handlers";
import { flush, NOW, SIGNING_SECRET, seedWorkspace, type TestDeps, testDeps } from "./helpers";

const NOT_SET_UP = "Google isn't set up for this Steward yet.";
const DISCONNECTED =
  "Google is disconnected. Events and auto-replies Steward already set stay as they are.";

function command(text: string): URLSearchParams {
  return new URLSearchParams({
    command: "/ooo",
    team_id: "T1",
    user_id: "U_DANA",
    user_name: "dana",
    trigger_id: "trig-1",
    response_url: "https://hooks.slack.com/commands/T1/1/r1",
    text,
  });
}

describe("googleCommandOf", () => {
  it.each([
    ["google", "google"],
    ["Google", "google"],
    ["google disconnect", "disconnect"],
    ["  Google   Disconnect ", "disconnect"],
    ["", null],
    ["hello", null],
    ["google foo", null],
    ["disconnect", null],
  ] as const)("%j -> %j", (text, expected) => {
    expect(googleCommandOf(text)).toBe(expected);
  });
});

describe("/ooo google", () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = testDeps();
  });

  it("gives a person without a connection a private link whose state is theirs", async () => {
    const person = await seedWorkspace(deps);
    const text = await handleSlashCommand(deps, command("google"));
    const match =
      /^Connect Google and Steward will also set your calendar and Gmail auto-reply: <(.+)\|Connect Google>\nThe link works for ten minutes\.$/.exec(
        text,
      );
    expect(match).not.toBeNull();
    const url = new URL(match?.[1] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://steward.example/oauth/google/start");
    const state = url.searchParams.get("state") ?? "";
    expect(await verifyGoogleState(SIGNING_SECRET, state, Math.floor(NOW / 1000))).toBe(person.id);
    expect(deps.slack.openedViews).toHaveLength(0);
    await flush(deps);
    expect(deps.slack.responses).toHaveLength(0);
  });

  it("tells a connected person who is connected and how to disconnect", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, { personId: person.id, workspaceId: "T1" });
    const text = await handleSlashCommand(deps, command("google"));
    expect(text).toContain("Google is connected as dana@example.com.");
    expect(text).toContain("/ooo google disconnect");
    expect(text).toContain("|Connect again>");
    expect(deps.slack.openedViews).toHaveLength(0);
  });

  it("leaves out the address when none is stored", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, {
      personId: person.id,
      workspaceId: "T1",
      email: "",
    });
    const text = await handleSlashCommand(deps, command("google"));
    expect(text.startsWith("Google is connected. To disconnect")).toBe(true);
  });

  it("offers a reconnect when Steward lost its access", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, {
      personId: person.id,
      workspaceId: "T1",
      health: "revoked",
    });
    const text = await handleSlashCommand(deps, command("google"));
    expect(text).toMatch(/^Steward lost its access to Google\. <https:\/\/.+\|Reconnect Google>\n/);
    expect(text).toContain("The link works for ten minutes.");
  });

  it("says Google is not set up when the OAuth client is not set", async () => {
    deps = testDeps({ googleClientId: null });
    await seedWorkspace(deps);
    expect(await handleSlashCommand(deps, command("google"))).toBe(NOT_SET_UP);
    expect(await handleSlashCommand(deps, command("google disconnect"))).toBe(NOT_SET_UP);
  });
});

describe("/ooo google disconnect", () => {
  let deps: TestDeps;

  beforeEach(() => {
    deps = testDeps();
  });

  it("deletes the row at once and revokes the refresh token afterwards", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(
      deps.db,
      deps.tokenKey,
      { personId: person.id, workspaceId: "T1" },
      { refresh: "1//the-refresh-token" },
    );
    const text = await handleSlashCommand(deps, command("google disconnect"));
    expect(text).toBe(DISCONNECTED);
    expect(await getGoogleConnection(deps.db, person.id)).toBeNull();
    await flush(deps);
    expect(deps.google.revoked).toEqual(["1//the-refresh-token"]);
    expect(deps.slack.openedViews).toHaveLength(0);
    expect(text).not.toContain("1//");
  });

  it("still answers the same, and the row stays gone, when the revoke fails", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, { personId: person.id, workspaceId: "T1" });
    deps.google.failNext.revokeToken = { status: 500, code: "http_500" };
    const text = await handleSlashCommand(deps, command("google disconnect"));
    expect(text).toBe(DISCONNECTED);
    await expect(flush(deps)).resolves.toBeUndefined();
    expect(await getGoogleConnection(deps.db, person.id)).toBeNull();
    expect(deps.google.revoked).toEqual([]);
  });

  it("says so when nothing is connected, and revokes nothing", async () => {
    await seedWorkspace(deps);
    const text = await handleSlashCommand(deps, command("google disconnect"));
    expect(text).toBe("Google isn't connected.");
    await flush(deps);
    expect(deps.google.revoked).toEqual([]);
  });

  it("deletes the row and skips the revoke when the refresh token cannot be opened", async () => {
    const person = await seedWorkspace(deps);
    await seedGoogleConnection(deps.db, deps.tokenKey, {
      personId: person.id,
      workspaceId: "T1",
      refreshTokenSealed: "not-a-sealed-token",
    });
    const text = await handleSlashCommand(deps, command("google disconnect"));
    expect(text).toBe(DISCONNECTED);
    await flush(deps);
    expect(await getGoogleConnection(deps.db, person.id)).toBeNull();
    expect(deps.google.revoked).toEqual([]);
  });
});

describe("/ooo without a Google word", () => {
  it.each(["", "hello", "google foo"])("%j opens the form as before", async (text) => {
    const deps = testDeps();
    await seedWorkspace(deps);
    expect(await handleSlashCommand(deps, command(text))).toBe("");
    expect(deps.slack.openedViews).toHaveLength(1);
  });
});
