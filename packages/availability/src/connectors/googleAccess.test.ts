import {
  FakeGoogleClient,
  GOOGLE_SCOPE,
  GoogleApiError,
  GoogleTokenSource,
  getGoogleConnection,
  newKeyB64,
  SkipWrite,
} from "@steward/core";
import { createTestDb, seedGoogleConnection } from "@steward/core/testing";
import { describe, expect, it } from "vitest";
import {
  CONNECT_GOOGLE,
  expiringOn401,
  GOOGLE_PERMISSION,
  googleAccessOrSkip,
  RECONNECT_GOOGLE,
} from "./googleAccess";

const PERSON = "T1:U1";

async function setup(row: Parameters<typeof seedGoogleConnection>[2] | null) {
  const db = createTestDb();
  const key = newKeyB64();
  if (row) await seedGoogleConnection(db, key, row);
  const tokens = new GoogleTokenSource({
    db,
    google: new FakeGoogleClient(),
    tokenKey: key,
    clientId: "id",
    clientSecret: "secret",
    now: () => 1_000,
  });
  return { db, tokens };
}

const healthy = { personId: PERSON, workspaceId: "T1" };

describe("googleAccessOrSkip", () => {
  it("skips with a connect hint when not connected", async () => {
    const { tokens } = await setup(null);
    const err = await googleAccessOrSkip(tokens, PERSON, GOOGLE_SCOPE.calendarEvents).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(CONNECT_GOOGLE);
  });

  it("skips with a reconnect hint when revoked", async () => {
    const { tokens } = await setup({ ...healthy, health: "revoked" });
    const err = await googleAccessOrSkip(tokens, PERSON, GOOGLE_SCOPE.calendarEvents).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(RECONNECT_GOOGLE);
  });

  it("skips when the scope was not granted", async () => {
    const { tokens } = await setup({ ...healthy, scopes: "openid email" });
    const err = await googleAccessOrSkip(tokens, PERSON, GOOGLE_SCOPE.calendarEvents).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SkipWrite);
    expect(err.reason).toBe(GOOGLE_PERMISSION);
  });

  it("returns the access token and the row", async () => {
    const { tokens } = await setup(healthy);
    const result = await googleAccessOrSkip(tokens, PERSON, GOOGLE_SCOPE.calendarEvents);
    expect(result.accessToken).toBe("ya29.access");
    expect(result.connection.personId).toBe(PERSON);
  });
});

describe("expiringOn401", () => {
  it("clears the stored access token on a 401 and rethrows the same error", async () => {
    const { db, tokens } = await setup(healthy);
    const error = new GoogleApiError("insertEvent", 401, "authError");
    await expect(
      expiringOn401(tokens, PERSON, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const row = await getGoogleConnection(db, PERSON);
    expect(row?.accessTokenSealed).toBeNull();
  });

  it("rethrows a 500 and leaves the token alone", async () => {
    const { db, tokens } = await setup(healthy);
    const error = new GoogleApiError("insertEvent", 500, "backendError");
    await expect(
      expiringOn401(tokens, PERSON, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const row = await getGoogleConnection(db, PERSON);
    expect(row?.accessTokenSealed).not.toBeNull();
  });

  it("returns the value on success", async () => {
    const { tokens } = await setup(healthy);
    expect(await expiringOn401(tokens, PERSON, async () => 42)).toBe(42);
  });
});
