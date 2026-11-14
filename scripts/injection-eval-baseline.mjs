#!/usr/bin/env node
/**
 * ADR-0244 (P25) — measure the heuristic prompt-injection detector against the
 * vendored snapshots and show the delta from the pinned baseline.
 *
 *   pnpm -C packages/shared build && node scripts/injection-eval-baseline.mjs           # print the delta table
 *   node scripts/injection-eval-baseline.mjs --write   # re-pin the heuristic numbers after a reviewed change
 *   node scripts/injection-eval-baseline.mjs --misses  # also list the case ids it misses or falsely flags
 *
 * Exit 1 on a regression beyond the configured tolerance (the CI test,
 * `injection-baselines.test.ts`, applies the same rule on every run). The
 * trained classifier's numbers come from `agents/trained-detectors/eval_baselines.py`.
 * Offline: reads only files in the repository.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = await import(path.join(root, "packages/shared/dist/index.js"));
const dir = path.join(root, "packages/shared/src/eval-datasets");
const expectedPath = path.join(dir, "injection-baselines.expected.json");
const write = process.argv.includes("--write");
const showMisses = process.argv.includes("--misses");

const expected = shared.injectionBaselineExpectedSchema.parse(JSON.parse(readFileSync(expectedPath, "utf8")));
const datasets = {};
const matrices = [];
for (const id of shared.INJECTION_BASELINE_DATASET_IDS) {
  const bytes = readFileSync(path.join(dir, shared.INJECTION_BASELINE_VENDOR_DIR, shared.INJECTION_BASELINE_FILES[id].file));
  const cases = shared.parseInjectionBaselineSnapshot(id, bytes);
  const r = shared.scoreInjectionCases(cases, (c) => shared.GUARDRAIL_DETECTORS.prompt_injection.detect(c.text, []).length > 0);
  datasets[id] = r.metrics;
  matrices.push(r.metrics);
  if (showMisses) {
    console.log(`${id}: missed ${r.misses.length}: ${r.misses.join(" ")}`);
    console.log(`${id}: false alarms ${r.falseAlarms.length}: ${r.falseAlarms.join(" ")}`);
  }
}
const measured = { datasets, pooled: shared.poolMetrics(matrices) };
const pinned = expected.detectors.heuristic_prompt_injection;
const deltas = shared.compareInjectionBaseline(pinned, measured, expected.tolerance);
console.log(shared.formatInjectionBaselineDeltas("heuristic_prompt_injection", deltas));

if (write) {
  expected.detectors.heuristic_prompt_injection = { ...pinned, datasets, pooled: measured.pooled };
  writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`re-pinned ${path.relative(root, expectedPath)}`);
} else if (deltas.some((d) => d.regression)) {
  console.error("regression beyond tolerance (see REGRESSION rows)");
  process.exit(1);
}
