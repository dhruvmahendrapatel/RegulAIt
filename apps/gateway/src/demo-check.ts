/**
 * Demo task C11 — `pnpm --filter @regulait/gateway demo:check`.
 *
 * Walks every storyline beat against the seeded database (run AFTER `seed` →
 * `demo:setup` → `demo:intake`) and prints PASS / WARN / FAIL per beat with
 * the fix. Exit 1 on any FAIL, 0 otherwise. Same environment as the seeders:
 * DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY.
 *
 * `--live` (ADR-0197 addendum decision 3): the live database, which holds real findings only. The seeded-dataset
 * beats are replaced: any trace of the fictional dataset FAILs, and the real discovery sources are reported.
 *
 * `--live-connections` (ADR-0202 lane L): also probe each live-demo connection (`demo:live-setup`) with one read-only
 * call through the egress guard, per beat, without printing a credential (`demo-live-check.ts`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import * as shared from "@regulait/shared";
import type { DemoIntakeFixtures } from "@regulait/shared";
import { buildApp } from "./app.js";
import { formatDemoCheck, runDemoCheck } from "./demo-check-lib.js";
import { runLiveConnectionChecks } from "./demo-live-check.js";
import { guardConnectionCall } from "./connection-egress.js";
import { decryptSecret } from "./secrets.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const live = process.argv.includes("--live");
const liveConnections = process.argv.includes("--live-connections");
const fixtures = (shared as unknown as { DEMO_INTAKE_FIXTURES?: DemoIntakeFixtures }).DEMO_INTAKE_FIXTURES ?? null;

const db = createDb(connectionString);
await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
const app = buildApp(db, { bootstrapToken: BOOT, dataKey: process.env.REGULAIT_DATA_KEY });
await app.ready();

const checks = await runDemoCheck(app, { bootstrapToken: BOOT, fixtures, live });
if (liveConnections) {
  const dataKey = process.env.REGULAIT_DATA_KEY;
  if (!dataKey) {
    checks.push({ beat: "live connections", level: "FAIL", detail: "REGULAIT_DATA_KEY is not set, so the live credentials cannot be read" });
  } else {
    checks.push(
      ...(await runLiveConnectionChecks(db, {
        env: process.env,
        decrypt: (c) => decryptSecret(dataKey, c),
        fetchFor: async (baseUrl, label) =>
          (await guardConnectionCall(db, {
            surface: baseUrl.startsWith("https://slack.com") ? "connector" : baseUrl.startsWith("https://api.github.com") ? "git_connection" : "pm_connection",
            baseUrl,
            label,
            detail: { probe: "demo:check --live-connections" },
          })).fetchImpl as never,
      })),
    );
  }
}
console.log(`demo:check${live ? " --live" : ""} — ${fixtures?.company.name ?? "no fixtures"}${live ? " (live database: real discovery only)" : ""}\n`);
console.log(formatDemoCheck(checks));
await app.close();
await (db.$client as { end: () => Promise<void> }).end();
process.exit(checks.some((c) => c.level === "FAIL") ? 1 : 0);
