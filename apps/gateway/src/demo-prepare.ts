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
 * Each step is the existing script, run as its own process with this
 * environment (DATABASE_URL, REGULAIT_BOOTSTRAP_TOKEN, REGULAIT_DATA_KEY), in
 * order; the first non-zero exit stops the run and names the step. Point
 * DATABASE_URL at an EMPTY database — this seeds, it does not reset.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");
// ADR-0197 decision 7: the Shadow-AI discovery dataset runs twice. Its first phase comes BEFORE the seed, in
// first-admin setup, because enabling a discovery source is a step-up the bootstrap credential gives only until an
// admin can step up (B4S-06); its second phase, after demo:intake, acts as the personas. Without it (`--live`) the
// seed is the first step, so its own first-admin-setup acts (the personas' one-time passwords, both admins' TOTP)
// still run inside that window.
const steps: Array<[string, string, ...string[]]> = live
  ? [
      ["seed", "seed.js"],
      ["demo:setup", "demo-setup.js"],
      ["demo:intake --live", "demo-intake-seed.js", "--live"],
      ["demo:traffic", "demo-traffic.js"],
      ["demo:check --live", "demo-check.js", "--live"],
    ]
  : [
      ["demo:shadow (first-admin setup)", "demo-shadow-seed.js", "--setup"],
      ["seed", "seed.js"],
      ["demo:setup", "demo-setup.js"],
      ["demo:intake", "demo-intake-seed.js"],
      ["demo:shadow", "demo-shadow-seed.js"],
      ["demo:traffic", "demo-traffic.js"],
      ["demo:check", "demo-check.js"],
    ];
const started = Date.now();
for (const [name, file, ...extra] of steps) {
  console.log(`\n=== ${name} ===`);
  // ADR-0181 FX3: the seed runs only on an explicit demo signal; this command
  // IS the demo, so it says so.
  // B4S-06: and the seed opens the assurance run's guardrail window during
  // first-admin setup (see seed.ts), which demo:intake keeps and closes
  const args = file === "seed.js" ? [path.join(here, file), "--seed-demo", "--open-assurance-window"] : [path.join(here, file), ...extra];
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`\ndemo:prepare${live ? " --live" : ""} stopped: ${name} exited ${r.status ?? r.signal}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\ndemo:prepare${live ? " --live" : ""} complete in ${Math.round((Date.now() - started) / 1000)}s`);
