import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./migrate.js";
export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
// Types consumers need to build reusable predicates without taking a direct
// dependency on drizzle-orm (PILLAR 1 rule-scoping SQL pre-filter, etc.).
export type { SQL } from "drizzle-orm";
export type { PgColumn } from "drizzle-orm/pg-core";

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}
