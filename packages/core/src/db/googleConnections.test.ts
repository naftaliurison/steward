import { describe, expect, it } from "vitest";
import { newKeyB64, open } from "../crypto/seal";
import { createTestDb, seedGoogleConnection } from "../testing";
import {
  calendarsOf,
  deleteGoogleConnection,
  GOOGLE_SCOPE,
  getGoogleConnection,
  hasGoogleScope,
  setGoogleAccessToken,
  setGoogleHealth,
  upsertGoogleConnection,
} from "./repo";

describe("google connections", () => {
  it("stores one connection per person, sealed, and reads it back", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const row = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    const read = await getGoogleConnection(db, "T1:U1");
    expect(read).toEqual(row);
    expect(read?.health).toBe("ok");
    expect(read?.refreshTokenSealed).not.toContain("1//refresh");
    expect(read && (await open(key, read.refreshTokenSealed))).toBe("1//refresh");
    expect(await getGoogleConnection(db, "T1:NOBODY")).toBeNull();
  });

  it("replaces the row when the person connects again", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const first = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    await upsertGoogleConnection(db, { ...first, email: "new@example.com", health: "ok" });
    expect((await getGoogleConnection(db, "T1:U1"))?.email).toBe("new@example.com");
  });

  it("updates the access token and the health, and deletes", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    await setGoogleAccessToken(db, "T1:U1", {
      accessTokenSealed: "sealed",
      accessExpiresAt: 99,
      updatedAt: 5,
    });
    await setGoogleHealth(db, "T1:U1", "revoked", 6);
    const read = await getGoogleConnection(db, "T1:U1");
    expect(read).toMatchObject({
      accessTokenSealed: "sealed",
      accessExpiresAt: 99,
      health: "revoked",
      updatedAt: 6,
    });
    await deleteGoogleConnection(db, "T1:U1");
    expect(await getGoogleConnection(db, "T1:U1")).toBeNull();
  });

  it("reads calendars and scopes, and survives a damaged calendars value", async () => {
    const db = createTestDb();
    const key = newKeyB64();
    const row = await seedGoogleConnection(db, key, { personId: "T1:U1", workspaceId: "T1" });
    expect(calendarsOf(row)).toEqual([
      { id: "dana@example.com", summary: "Dana", primary: true, chosen: true },
    ]);
    expect(calendarsOf({ ...row, calendars: "not json" })).toEqual([]);
    expect(hasGoogleScope(row, GOOGLE_SCOPE.gmailSettings)).toBe(true);
    expect(hasGoogleScope({ ...row, scopes: "openid email" }, GOOGLE_SCOPE.gmailSettings)).toBe(
      false,
    );
  });
});
