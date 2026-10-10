/**
 * Demo task C16 — `pnpm --filter @regulait/gateway demo:prepare`: the ONE
 * command that rebuilds a demo database from empty (milestone M3):
 *
 *   seed → demo:setup → demo:intake → demo:traffic → demo:check
 *
 * Each step is the existing script, run as its own process with this
 * environment (DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY), in
 * order; the first non-zero exit stops the run and names the step. Point
 * DATABASE_URL at an EMPTY database — this seeds, it does not reset.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const steps: Array<[string, string]> = [
  ["seed", "seed.js"],
  ["demo:setup", "demo-setup.js"],
  ["demo:intake", "demo-intake-seed.js"],
  ["demo:traffic", "demo-traffic.js"],
  ["demo:check", "demo-check.js"],
];
const started = Date.now();
for (const [name, file] of steps) {
  console.log(`\n=== ${name} ===`);
  // ADR-0181 FX3: the seed runs only on an explicit demo signal; this command
  // IS the demo, so it says so.
  // B4S-06: and the seed opens the assurance run's guardrail window during
  // first-admin setup (see seed.ts), which demo:intake keeps and closes
  const args = file === "seed.js" ? [path.join(here, file), "--seed-demo", "--open-assurance-window"] : [path.join(here, file)];
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`\ndemo:prepare stopped: ${name} exited ${r.status ?? r.signal}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\ndemo:prepare complete in ${Math.round((Date.now() - started) / 1000)}s`);
