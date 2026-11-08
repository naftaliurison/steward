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
