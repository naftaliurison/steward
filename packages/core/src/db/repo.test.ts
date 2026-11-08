import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../testing";
import type { Db } from "./client";
import {
  ensurePerson,
  getWorkspace,
  setPersonUserToken,
  updatePersonProfile,
  upsertWorkspace,
} from "./repo";
import * as schema from "./schema";

describe("repo", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb();
  });

  it("upserts a workspace and reads it back", async () => {
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme",
      botTokenSealed: "sealed-bot",
      botUserId: "UBOT",
      installedAt: 1_000,
    });
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme Renamed",
      botTokenSealed: "sealed-bot-2",
      botUserId: "UBOT",
      installedAt: 2_000,
    });
    const ws = await getWorkspace(db, "T1");
    expect(ws?.name).toBe("Acme Renamed");
    expect(ws?.botTokenSealed).toBe("sealed-bot-2");
    expect(await getWorkspace(db, "T2")).toBeNull();
  });

  it("ensurePerson creates once and returns the same row afterwards", async () => {
    const first = await ensurePerson(db, "T1", "U1", "Dana");
    const again = await ensurePerson(db, "T1", "U1", "Dana (renamed)");
    expect(first.id).toBe("T1:U1");
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe("Dana");
    expect(again.tz).toBe("UTC");
    expect(again.userTokenSealed).toBeNull();
  });

  it("stores a sealed user token", async () => {
    const person = await ensurePerson(db, "T1", "U1", "Dana");
    const updated = await setPersonUserToken(db, person.id, "sealed-user");
    expect(updated.userTokenSealed).toBe("sealed-user");
  });

  it("updates a person's profile from Slack and records when", async () => {
    const person = await ensurePerson(db, "T1", "U1", "U1");
    expect(person.profileSyncedAt).toBeNull();
    const updated = await updatePersonProfile(db, person.id, {
      displayName: "Dana",
      tz: "Asia/Jerusalem",
      profileSyncedAt: 5_000,
    });
    expect(updated).toMatchObject({
      displayName: "Dana",
      tz: "Asia/Jerusalem",
      profileSyncedAt: 5_000,
    });
  });

  it("ensurePerson tolerates two first calls at once", async () => {
    const [a, b] = await Promise.all([
      ensurePerson(db, "T1", "U7", "Noa"),
      ensurePerson(db, "T1", "U7", "Noa"),
    ]);
    expect(a.id).toBe("T1:U7");
    expect(b.id).toBe("T1:U7");
    const rows = await db.select().from(schema.people).where(eq(schema.people.id, "T1:U7"));
    expect(rows).toHaveLength(1);
  });
});
