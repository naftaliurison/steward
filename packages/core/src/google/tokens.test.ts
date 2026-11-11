import { describe, expect, it } from "vitest";
import { newKeyB64, open } from "../crypto/seal";
import { getGoogleConnection } from "../db/repo";
import { createTestDb, seedGoogleConnection } from "../testing";
import { GoogleApiError } from "./client";
import { FakeGoogleClient } from "./fake";
import { ACCESS_TOKEN_MARGIN_MS, GoogleTokenSource } from "./tokens";

const NOW = 1_000_000;
const PERSON = "T1:U1";

async function setup(
  row: Parameters<typeof seedGoogleConnection>[2] | null = {
    personId: PERSON,
    workspaceId: "T1",
    accessExpiresAt: NOW + 3_600_000,
  },
  tokens: Parameters<typeof seedGoogleConnection>[3] = {},
) {
  const db = createTestDb();
  const key = newKeyB64();
  const fake = new FakeGoogleClient();
  if (row) await seedGoogleConnection(db, key, row, tokens);
  const source = new GoogleTokenSource({
    db,
    google: fake,
    tokenKey: key,
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => NOW,
  });
  return { db, key, fake, source };
}

describe("GoogleTokenSource", () => {
  it("says not_connected when the person has no connection", async () => {
    const { fake, source } = await setup(null);
    expect(await source.accessFor(PERSON)).toEqual({ ok: false, reason: "not_connected" });
    expect(fake.refreshes).toEqual([]);
  });

  it("says reconnect when the connection is revoked", async () => {
    const { fake, source } = await setup({
      personId: PERSON,
      workspaceId: "T1",
      health: "revoked",
    });
    expect(await source.accessFor(PERSON)).toEqual({ ok: false, reason: "reconnect" });
    expect(fake.refreshes).toEqual([]);
  });

  it("returns a fresh stored token without calling Google", async () => {
    const { fake, source } = await setup();
    const result = await source.accessFor(PERSON);
    expect(result).toMatchObject({ ok: true, accessToken: "ya29.access" });
    expect(fake.refreshes).toEqual([]);
  });

  it("refreshes a token with exactly the margin left", async () => {
    const { fake, source } = await setup({
      personId: PERSON,
      workspaceId: "T1",
      accessExpiresAt: NOW + ACCESS_TOKEN_MARGIN_MS,
    });
    expect(await source.accessFor(PERSON)).toMatchObject({ ok: true, accessToken: "ya29.fresh" });
    expect(fake.refreshes).toEqual(["1//refresh"]);
  });

  it("refreshes an expired token and stores the new one sealed", async () => {
    const { db, key, fake, source } = await setup({
      personId: PERSON,
      workspaceId: "T1",
      accessExpiresAt: NOW - 1,
    });
    expect(await source.accessFor(PERSON)).toMatchObject({ ok: true, accessToken: "ya29.fresh" });
    expect(fake.refreshes).toEqual(["1//refresh"]);
    const row = await getGoogleConnection(db, PERSON);
    expect(row?.accessTokenSealed).not.toContain("ya29.fresh");
    expect(row?.accessTokenSealed && (await open(key, row.accessTokenSealed))).toBe("ya29.fresh");
    expect(row?.accessExpiresAt).toBe(NOW + 3_600_000);
  });

  it("refreshes when no access token is stored", async () => {
    const { fake, source } = await setup({ personId: PERSON, workspaceId: "T1" }, { access: null });
    expect(await source.accessFor(PERSON)).toMatchObject({ ok: true, accessToken: "ya29.fresh" });
    expect(fake.refreshes).toEqual(["1//refresh"]);
  });

  it("marks the connection revoked when Google says invalid_grant", async () => {
    const { db, fake, source } = await setup(
      { personId: PERSON, workspaceId: "T1" },
      { access: null },
    );
    fake.failNext.refreshAccessToken = { status: 400, code: "invalid_grant" };
    expect(await source.accessFor(PERSON)).toEqual({ ok: false, reason: "reconnect" });
    expect((await getGoogleConnection(db, PERSON))?.health).toBe("revoked");
  });

  it("rethrows any other refresh error and keeps the health ok", async () => {
    const { db, fake, source } = await setup(
      { personId: PERSON, workspaceId: "T1" },
      { access: null },
    );
    fake.failNext.refreshAccessToken = { status: 500, code: "backendError" };
    await expect(source.accessFor(PERSON)).rejects.toBeInstanceOf(GoogleApiError);
    expect((await getGoogleConnection(db, PERSON))?.health).toBe("ok");
  });

  it("forgets the stored token on expire so the next call refreshes", async () => {
    const { db, fake, source } = await setup();
    await source.expire(PERSON);
    const row = await getGoogleConnection(db, PERSON);
    expect(row?.accessTokenSealed).toBeNull();
    expect(row?.accessExpiresAt).toBeNull();
    expect(await source.accessFor(PERSON)).toMatchObject({ ok: true, accessToken: "ya29.fresh" });
    expect(fake.refreshes).toEqual(["1//refresh"]);
  });
});
