import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}
