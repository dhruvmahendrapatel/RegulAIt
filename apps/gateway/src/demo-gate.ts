/**
 * `pnpm --filter @regulait/gateway demo:gate -- "<use case name>" [environment] [ref]`
 *
 * The deploy-gate beat as a CI step (see demo-gate-lib.ts): prints the gate's
 * decision and reasons and exits 1 on DENY, 0 on ALLOW, 2 on a setup error.
 * Same environment as the other demo commands: DATABASE_URL,
 * REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { buildApp } from "./app.js";
import { runDemoGate } from "./demo-gate-lib.js";

const [useCase, environment, ref] = process.argv.slice(2).filter((a) => a !== "--");
if (!useCase) {
  console.error('usage: demo:gate -- "<use case name>" [environment] [ref]');
  process.exit(2);
}
const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: process.env.REGULAIT_DATA_KEY });
await app.ready();
const result = await runDemoGate(app, { bootstrapToken: BOOT, useCase, ...(environment ? { environment } : {}), ...(ref ? { ref } : {}) });
console.log(result.lines.join("\n"));
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(result.exitCode);
