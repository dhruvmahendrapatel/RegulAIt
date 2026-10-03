/**
 * Demo task C15 — `pnpm --filter @regulait/gateway demo:traffic` (after
 * `seed → demo:setup → demo:intake`): governed mock traffic for the Monitor &
 * Respond beats. Same environment as the seeders.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import * as shared from "@regulait/shared";
import type { DemoIntakeFixtures } from "@regulait/shared";
import { buildApp } from "./app.js";
import { formatDemoTraffic, runDemoTraffic } from "./demo-traffic-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const fixtures = (shared as unknown as { DEMO_INTAKE_FIXTURES?: DemoIntakeFixtures }).DEMO_INTAKE_FIXTURES ?? null;

const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: process.env.REGULAIT_DATA_KEY });
await app.ready();
const report = await runDemoTraffic(app, { bootstrapToken: BOOT, fixtures });
console.log("demo:traffic\n");
console.log(formatDemoTraffic(report));
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(report.results.length === 0 ? 1 : 0);
