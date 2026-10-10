import { defineConfig } from "vitest/config";

/**
 * ADR-0186 decision 30 item 3 (B4I-03): the wall-clock budget tests run in their own project, one file at a
 * time, after every other shared test file has finished (`sequence.groupOrder`). A budget measured while
 * sibling test files saturate the CPU measures the neighbours, not the code; under the default parallel run
 * the 100 ms scrub budgets and the 5 s candidate oracle failed intermittently with no code change. The budgets
 * themselves are unchanged. Everything else keeps the default file parallelism.
 *
 * A new test that asserts elapsed wall time belongs in TIMING_FILES; `timing-isolation.test.ts` fails if a
 * test file measures time with `performance.now()` or `Date.now()` and an upper bound outside this list.
 */
export const TIMING_FILES = [
  "src/audit-scrub-redos.test.ts",
  "src/chatops-redos.test.ts",
  "src/secret-patterns.test.ts",
  "src/pii-linear.test.ts",
  "src/linear-scan.test.ts",
  "src/batch4.test.ts",
  "src/detection-content/vendor.test.ts",
  "src/detection-content/scrub-dense.test.ts",
  // no explicit budget, but 40k-string measurements bounded by the default 5 s test timeout: under a parallel
  // run on a loaded 4-core host it took 8.3 s and timed out (2026-10-10)
  "src/pii-conformance.test.ts",
  // no budget, but a full RE2 scan of all 61 rules over seven 400k inputs: serialized so it neither starves nor
  // is starved by the parallel project (ADR-0186 decision 31)
  "src/detection-content/scan-plans.test.ts",
  // ADR-0189 B1: 100k-character adversarial inputs for every BOM pattern check (CodeQL js/polynomial-redos)
  "src/bom/bom-timing.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: TIMING_FILES, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "timing", include: TIMING_FILES, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
