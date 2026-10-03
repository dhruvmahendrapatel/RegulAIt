/**
 * Demo task C11 — `pnpm --filter @regulait/gateway demo:check`.
 *
 * Walks every storyline beat against the seeded database (run AFTER `seed` →
 * `demo:setup` → `demo:intake`) and prints PASS / WARN / FAIL per beat with
 * the fix. Exit 1 on any FAIL, 0 otherwise. Same environment as the seeders:
 * DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import * as shared from "@regulait/shared";
import type { DemoIntakeFixtures } from "@regulait/shared";
import { buildApp } from "./app.js";
import { formatDemoCheck, runDemoCheck } from "./demo-check-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const fixtures = (shared as unknown as { DEMO_INTAKE_FIXTURES?: DemoIntakeFixtures }).DEMO_INTAKE_FIXTURES ?? null;

const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: process.env.REGULAIT_DATA_KEY });
await app.ready();

const checks = await runDemoCheck(app, { bootstrapToken: BOOT, fixtures });
console.log(`demo:check — ${fixtures?.company.name ?? "no fixtures"}\n`);
console.log(formatDemoCheck(checks));
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(checks.some((c) => c.level === "FAIL") ? 1 : 0);
