import { schema, upsertWorkspace } from "@steward/core";
import { applyD1Migrations } from "@steward/core/testing";
import { eq } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createD1Db } from "../src/db";
import {
  advanceDemoClock,
  createDemoSession,
  DEMO_SESSION_TTL_MS,
  demoWorkspaceId,
} from "../src/demo/session";
import { DemoSlackClient, readDemoEvents } from "../src/demo/slackClient";
import { runTick } from "../src/tick";
import { NOW, type TestDeps, testDeps } from "./helpers";

describe("the demo on the real D1 driver (Miniflare)", () => {
  let mf: Miniflare;
  let deps: TestDeps;
  let queries = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "steward-demo-smoke" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyD1Migrations(d1);
    // Count every statement the code prepares: this is what D1 counts per invocation.
    const counted = new Proxy(d1, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== "function") return value;
        if (prop !== "prepare") return value.bind(target);
        return (query: string) => {
          queries++;
          return target.prepare(query);
        };
      },
    });
    deps = { ...testDeps(), db: createD1Db(counted) };
  }, 90_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("numbers a session's events without repeats when calls race", async () => {
    const slack = new DemoSlackClient(deps.db, "race", () => NOW);
    await Promise.all(Array.from({ length: 6 }, () => slack.clearUserStatus({ userToken: "t" })));
    expect((await readDemoEvents(deps.db, "race")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 60_000);

  it("counts the day's sessions exactly and adds up clock advances when requests race", async () => {
    const created = await Promise.all(Array.from({ length: 5 }, () => createDemoSession(deps, {})));
    const first = created[0];
    if (!first || "error" in first) throw new Error("unexpected busy");
    const day = new Date(NOW).toISOString().slice(0, 10);
    const [budget] = await deps.db
      .select()
      .from(schema.demoDays)
      .where(eq(schema.demoDays.day, day));
    expect(budget?.sessions).toBe(5);

    await Promise.all([1, 2, 3].map(() => advanceDemoClock(deps, first, 10 * 60 * 1000)));
    const [row] = await deps.db
      .select()
      .from(schema.demoSessions)
      .where(eq(schema.demoSessions.id, first.id));
    expect(row?.clockOffsetMs).toBe(30 * 60 * 1000);
  }, 60_000);

  it("cleans up any number of expired sessions in a fixed number of queries, and leaves the rest", async () => {
    // The five sessions above expire at NOW + TTL. Around them: a fresh session with an event, an old
    // and a young session-less demo workspace, a real workspace, a stray event, an old budget row.
    const later = NOW + DEMO_SESSION_TTL_MS + 1;
    deps.clock.now = later - 60_000;
    const fresh = await createDemoSession(deps, {});
    if ("error" in fresh) throw new Error("unexpected busy");
    await new DemoSlackClient(deps.db, fresh.id, () => later).clearUserStatus({ userToken: "t" });
    const workspace = (id: string, installedAt: number) =>
      upsertWorkspace(deps.db, {
        id,
        name: "x",
        botTokenSealed: "sealed",
        botUserId: "UB",
        installedAt,
      });
    await workspace("demo:old-orphan", NOW);
    await workspace("demo:young-orphan", later - 1000);
    await workspace("T_REAL", 1);
    await deps.db.insert(schema.demoDays).values({ day: "2026-01-01", sessions: 9 });

    deps.clock.now = later;
    queries = 0;
    const result = await runTick(deps);
    expect(result.demoSessionsRemoved).toBe(5);
    expect(queries).toBeLessThanOrEqual(20);

    const ids = (await deps.db.select({ id: schema.workspaces.id }).from(schema.workspaces)).map(
      (w) => w.id,
    );
    expect(ids.sort()).toEqual(["T_REAL", "demo:young-orphan", demoWorkspaceId(fresh.id)].sort());
    expect((await deps.db.select().from(schema.demoSessions)).map((s) => s.id)).toEqual([fresh.id]);
    // The "race" events of the first test have no session: they are swept. The fresh session's event stays.
    expect((await deps.db.select().from(schema.demoEvents)).map((e) => e.sessionId)).toEqual([
      fresh.id,
    ]);
    expect(await deps.db.select().from(schema.people)).toHaveLength(3);
    expect((await deps.db.select().from(schema.demoDays)).map((d) => d.day)).not.toContain(
      "2026-01-01",
    );
  }, 60_000);
});
