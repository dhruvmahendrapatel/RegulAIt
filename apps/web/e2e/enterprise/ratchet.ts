/**
 * The enterprise harness's ratchet (ADR-0196), the browser half of the model the import-cycle job uses (#387).
 *
 * Each check reports its FINDINGS for one KEY (a route, plus the theme, browser or journey) as `{ finding: count }`.
 * A finding whose count is above the committed baseline (baselines/<category>.json) fails the test: a new
 * violation, or more of an old one. A count at or below the baseline passes, so a builder fixing an existing
 * violation is never blocked by this harness; they shrink the baseline afterwards with
 * `node scripts/ui-enterprise-baseline.mjs --update` (CI refuses a baseline file that GROWS against the base branch).
 *
 * Every report is also written to the findings directory (ENTERPRISE_FINDINGS_DIR, default
 * apps/web/test-results/enterprise-findings), which `--update` reads. With ENTERPRISE_RECORD=1 nothing fails: the
 * run only records, which is how a baseline is first written (locally, followed by `--update`).
 *
 * Record mode turns every browser check into record-only, and the baseline guard cannot see that, so in CI (the `CI`
 * variable set) it is refused unless the run exists to rewrite the baselines: ENTERPRISE_RECORD=update on a manual
 * (workflow_dispatch) run. A pull-request run can never record. See recordMode() in record-mode.ts.
 */
import { mkdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type TestInfo } from "@playwright/test";
import { recordMode } from "./record-mode";

export { recordMode };

export type Category = "axe" | "keyboard" | "responsive" | "states" | "density" | "perf";
export type Findings = Record<string, number>;
type Baseline = Record<string, Findings>;

const here = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_DIR = path.join(here, "baselines");
export const FINDINGS_DIR = process.env.ENTERPRISE_FINDINGS_DIR ?? path.resolve(here, "..", "..", "test-results", "enterprise-findings");

const RECORD = recordMode();

const cache = new Map<Category, Baseline>();
function baseline(category: Category): Baseline {
  let b = cache.get(category);
  if (!b) {
    const file = path.join(BASELINE_DIR, `${category}.json`);
    b = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).entries as Baseline) : {};
    cache.set(category, b);
  }
  return b;
}

/** the findings above the baseline, as readable lines (empty when within it) */
export function regressions(category: Category, key: string, findings: Findings): string[] {
  const allowed = baseline(category)[key] ?? {};
  return Object.entries(findings)
    .filter(([finding, count]) => count > (allowed[finding] ?? 0))
    .map(([finding, count]) => `${finding}: ${count} (baseline ${allowed[finding] ?? 0})`)
    .sort();
}

/** record the findings for `key`, then fail on anything above the baseline (unless recording) */
export function ratchet(testInfo: TestInfo, category: Category, key: string, findings: Findings, detail: string[] = []) {
  mkdirSync(FINDINGS_DIR, { recursive: true });
  appendFileSync(
    path.join(FINDINGS_DIR, `${category}.${testInfo.project.name}.${testInfo.workerIndex}.jsonl`),
    `${JSON.stringify({ category, key, findings })}\n`,
  );
  if (RECORD) return;
  const over = regressions(category, key, findings);
  expect.soft(over, `${category} on ${key}: new findings above the committed baseline${detail.length ? `\n${detail.join("\n")}` : ""}`).toEqual([]);
}

/** add one to `finding` */
export const bump = (f: Findings, finding: string, by = 1) => {
  f[finding] = (f[finding] ?? 0) + by;
};
