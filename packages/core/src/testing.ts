import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./db/client";
import * as schema from "./db/schema";

/** An in-memory SQLite database with all migrations applied. Node only. */
export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  const here = path.dirname(fileURLToPath(import.meta.url));
  migrate(db, { migrationsFolder: path.join(here, "../drizzle") });
  return db as unknown as Db;
}

/** Applies the committed migrations to a D1 database, statement by statement, the way `wrangler d1 migrations apply` does. Node only. */
export async function applyD1Migrations(d1: {
  prepare(query: string): { run(): Promise<unknown> };
}): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const raw of text.split("--> statement-breakpoint")) {
      const statement = raw.replace(/\s+/g, " ").trim();
      if (statement) await d1.prepare(statement).run();
    }
  }
}
