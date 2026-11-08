import { schema } from "@steward/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runTick } from "../src/tick";
import { NOW, testDeps } from "./helpers";

describe("tick", () => {
  it("closes undo windows that have passed and leaves open ones alone", async () => {
    const deps = testDeps();
    const base = {
      workspaceId: "T1",
      personId: "T1:U1",
      type: "out",
      startMs: 0,
      endMs: 1,
      text: "x",
      emoji: ":x:",
      state: "active",
      source: "form",
      createdAt: 0,
      replacedStatusId: null,
    };
    await deps.db.insert(schema.statuses).values([
      { ...base, id: "old", undoUntilMs: NOW - 1 },
      { ...base, id: "fresh", undoUntilMs: NOW + 60_000 },
      { ...base, id: "none", undoUntilMs: null },
    ]);
    expect(await runTick(deps)).toEqual({ undoWindowsExpired: 1 });
    const old = await deps.db.select().from(schema.statuses).where(eq(schema.statuses.id, "old"));
    const fresh = await deps.db
      .select()
      .from(schema.statuses)
      .where(eq(schema.statuses.id, "fresh"));
    expect(old[0]?.undoUntilMs).toBeNull();
    expect(fresh[0]?.undoUntilMs).toBe(NOW + 60_000);
    expect(await runTick(deps)).toEqual({ undoWindowsExpired: 0 });
  });
});
