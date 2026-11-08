import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/** Works for both the D1 driver (async) and the better-sqlite3 driver used in tests (sync). */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;
