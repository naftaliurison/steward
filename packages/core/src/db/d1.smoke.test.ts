import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Connector, ConnectorRegistry, type WriteSpec } from "../engine/connector";
import { createTargets, executeTargets, undoTargets } from "../engine/engine";
import type { Db } from "./client";
import { ensurePerson, getPerson, upsertWorkspace } from "./repo";
import * as schema from "./schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "../../drizzle");

/** Applies the committed migrations statement by statement, the way `wrangler d1 migrations apply` does. */
async function applyMigrations(d1: D1Database): Promise<void> {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const raw of sql.split("--> statement-breakpoint")) {
      const statement = raw.replace(/\s+/g, " ").trim();
      if (statement) await d1.prepare(statement).run();
    }
  }
}

describe("D1 driver smoke (Miniflare)", () => {
  let mf: Miniflare;
  let db: Db;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "steward-smoke" },
    });
    const d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await applyMigrations(d1);
    db = drizzle(d1, { schema }) as unknown as Db;
  }, 90_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("runs the repo and the engine against the real D1 driver", async () => {
    await upsertWorkspace(db, {
      id: "T1",
      name: "Acme",
      botTokenSealed: "sealed",
      botUserId: "UB",
      installedAt: 1,
    });
    const person = await ensurePerson(db, "T1", "U1", "Dana");
    expect((await getPerson(db, person.id))?.tz).toBe("UTC");

    await db.insert(schema.statuses).values({
      id: "S1",
      workspaceId: "T1",
      personId: person.id,
      type: "out",
      startMs: 1,
      endMs: 2,
      text: "Out",
      emoji: ":x:",
      state: "active",
      source: "form",
      createdAt: 0,
      undoUntilMs: null,
      replacedStatusId: null,
    });
    const seen: string[] = [];
    const connector: Connector = {
      system: "a",
      async perform(_spec, ctx) {
        seen.push(ctx.idempotencyKey);
        return { externalId: "ext-1" };
      },
      async undo(externalId) {
        seen.push(`undo:${externalId}`);
      },
    };
    const registry = new ConnectorRegistry().register(connector);
    const actor = { workspaceId: "T1", personId: person.id, userToken: null };
    const specs: WriteSpec[] = [{ system: "a", op: "set", args: { v: 1 } }];
    const created = await createTargets(db, "S1", specs);
    const done = await executeTargets(db, registry, actor, created, () => 5);
    expect(done.map((t) => [t.state, t.externalId, t.attempts])).toEqual([["done", "ext-1", 1]]);
    const undone = await undoTargets(db, registry, actor, done, () => 6);
    expect(undone.map((t) => t.state)).toEqual(["undone"]);
    expect(seen).toEqual(["S1:a:set", "undo:ext-1"]);
    const auditRows = await db.select().from(schema.audit);
    expect(auditRows.map((r) => `${r.action}:${r.result}`)).toEqual([
      "a.set:done",
      "a.set.undo:undone",
    ]);
  });
});
