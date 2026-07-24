import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./migrate.js";
export { and, desc, eq } from "drizzle-orm";

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}
