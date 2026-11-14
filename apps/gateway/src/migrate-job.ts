/**
 * ADR-0304 entrypoint: `node apps/gateway/dist/migrate-job.js`. See migrate-job-run.ts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { runMigrateJob } from "./migrate-job-run.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

process.exitCode = await runMigrateJob(process.env, {
  connect: (url) => {
    const db = createDb(url);
    return Object.assign(db, { close: () => (db.$client as { end: () => Promise<void> }).end() });
  },
  migrate: (handle) => runMigrations(handle as Db, migrationsFolder),
  log: (line) => console.log(line),
});
