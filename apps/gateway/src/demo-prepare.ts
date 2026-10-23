/**
 * Demo task C16 — `pnpm --filter @regulait/gateway demo:prepare`: the ONE
 * command that rebuilds a demo database from empty (milestone M3):
 *
 *   demo:shadow --setup → seed → demo:setup → demo:intake → demo:shadow → demo:traffic → demo:check
 *
 * `demo:prepare --live` (ADR-0197 addendum decision 3; owner, 2026-10-19): the live database, which holds real
 * findings only. Both demo:shadow phases are skipped, demo:intake runs with `--live` (the shipped signature catalogues,
 * not the synthetic SaaS export) and the last step is `demo:check --live`:
 *
 *   seed → demo:setup → demo:intake --live → demo:traffic → demo:check --live
 *
 * The steps live in demo-prepare-steps.ts, which the Docker demo (docker-start.sh) also runs, through
 * `demo-prepare.js --steps`: that prints the demo list and exits, preparing nothing.
 *
 * Each step is the existing script, run as its own process with this
 * environment (DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY), in
 * order; the first non-zero exit stops the run and names the step. Point
 * DATABASE_URL at an EMPTY database — this seeds, it does not reset.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoPrepareSteps, formatDemoPrepareSteps } from "./demo-prepare-steps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--steps")) {
  // the Docker demo only: never the live list, whatever else was passed
  console.log(formatDemoPrepareSteps(demoPrepareSteps(false)));
  process.exit(0);
}
const live = process.argv.includes("--live");
const started = Date.now();
for (const { name, file, args } of demoPrepareSteps(live)) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(here, file), ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`\ndemo:prepare${live ? " --live" : ""} stopped: ${name} exited ${r.status ?? r.signal}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\ndemo:prepare${live ? " --live" : ""} complete in ${Math.round((Date.now() - started) / 1000)}s`);
