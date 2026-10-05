/**
 * `pnpm --filter @regulait/gateway demo:intake` — load the AI-intake demo
 * dataset (demo task C6). Run AFTER `seed` and `demo:setup` (which installs
 * the demo licence so the packs can be activated). Same environment as those:
 * DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY.
 *
 * In-process like `demo-setup.ts`: no running gateway needed. Idempotent.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import * as shared from "@regulait/shared";
import type { DemoIntakeFixtures } from "@regulait/shared";
import { buildApp } from "./app.js";
import { seedDemoIntake } from "./demo-intake-seed-lib.js";
import { recertifyDemoModelCards } from "./demo-strict-governance.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";

// Read at RUNTIME, so this script builds before the fixtures exist (they are a
// separate task) and says plainly what is missing instead of failing to compile.
const fixtures = (shared as unknown as { DEMO_INTAKE_FIXTURES?: DemoIntakeFixtures }).DEMO_INTAKE_FIXTURES;
if (!fixtures) {
  console.error(
    "demo:intake — DEMO_INTAKE_FIXTURES is not exported from @regulait/shared yet " +
      "(task G1, packages/shared/src/demo-intake/fixtures.ts). Nothing was seeded.",
  );
  process.exit(1);
}

const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: process.env.REGULAIT_DATA_KEY });
await app.ready();

const report = await seedDemoIntake(app, fixtures, { bootstrapToken: BOOT });
console.log(`demo:intake — ${fixtures.company.name}`);
console.log(`  created ${report.created.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
for (const n of report.notes) console.log(`  note    ${n}`);
for (const f of report.failed) console.log(`  FAILED  ${f}`);
// ADR-0181 SB2: the required-test runs above moved the cards' ledger; Avery recertifies them
for (const n of await recertifyDemoModelCards(app, BOOT)) console.log(`  ${n}`);
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(report.failed.length ? 2 : 0);
