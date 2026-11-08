import { type Db, schema } from "@steward/core";
import { drizzle } from "drizzle-orm/d1";

export function createD1Db(d1: D1Database): Db {
  return drizzle(d1, { schema }) as unknown as Db;
}
