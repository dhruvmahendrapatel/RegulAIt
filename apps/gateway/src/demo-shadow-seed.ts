/**
 * ADR-0197 decision 7 — load the fallback Shadow-AI discovery dataset (see demo-shadow-seed-lib.ts).
 *
 *   node dist/demo-shadow-seed.js --setup   BEFORE `seed`, in first-admin setup: sources, their stepped-up enables,
 *                                           the recorded runs, the MDM import, the endpoint device, the trusted
 *                                           connector
 *   node dist/demo-shadow-seed.js           after `demo:intake`: the remediation workflow and the provenance reads,
 *                                           and a repair of anything the first phase left incomplete
 *
 * `demo:prepare` runs both. Same environment as the other seeders: DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN,
 * REGULAIT_DATA_KEY. In-process like `demo-intake-seed.ts`: no running gateway needed. Idempotent.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { DEMO_SHADOW_DISCOVERY } from "@regulait/shared";
import { buildApp } from "./app.js";
import { seedShadowSetup, seedShadowStory } from "./demo-shadow-seed-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const DATA_KEY = process.env.REGULAIT_DATA_KEY;
const setup = process.argv.includes("--setup");

const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
await app.ready();

const opts = { bootstrapToken: BOOT, dataKey: DATA_KEY };
const report = setup ? await seedShadowSetup(app, db, DEMO_SHADOW_DISCOVERY, opts) : await seedShadowStory(app, db, DEMO_SHADOW_DISCOVERY, opts);
console.log(`demo:shadow${setup ? " (first-admin setup)" : ""} — ${DEMO_SHADOW_DISCOVERY.company}`);
console.log(`  created ${report.created.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
for (const c of report.created) console.log(`  created ${c}`);
for (const n of report.notes) console.log(`  note    ${n}`);
for (const f of report.failed) console.log(`  FAILED  ${f}`);
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(report.failed.length ? 2 : 0);
