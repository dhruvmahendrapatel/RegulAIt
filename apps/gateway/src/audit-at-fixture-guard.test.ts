/**
 * PR #377 review (F2): the caller-named audit timestamp is a TEST FIXTURE path. The chained writer refuses a
 * caller-named `at`; `runWithCallerAuditAtForTest` (and the gateway's `testing/backdated-audit.ts` over it) is the
 * one way round that, and it runs only under a test runner. This pins, statically, that no product source under
 * `apps/` or `packages/` reaches it: only its definition, its package re-export, the fixture helper itself and test
 * files may name it. No database.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "artifacts", "test-results", "playwright-report"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/;

/** the files allowed to name the fixture path, relative to the repo root */
const ALLOWED = new Set([
  "packages/db/src/audit-chain.ts", // the definition
  "packages/db/src/index.ts", // the package re-export
  "apps/gateway/src/testing/backdated-audit.ts", // the fixture helper over it
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
}

describe("the caller-named audit timestamp stays a test fixture", () => {
  it("no product source under apps/ or packages/ names runWithCallerAuditAtForTest or testing/backdated-audit", () => {
    const files: string[] = [];
    for (const top of ["apps", "packages"]) walk(path.join(ROOT, top), files);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    const seenAllowed: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (TEST.test(rel) || rel.includes("/e2e/")) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes("runWithCallerAuditAtForTest") && !text.includes("backdated-audit")) continue;
      if (ALLOWED.has(rel)) seenAllowed.push(rel);
      else offenders.push(rel);
    }
    expect(offenders, "product source reaches the test-only audit timestamp path").toEqual([]);
    // the allow-list cannot rot: every entry still exists and still names it
    expect(seenAllowed.sort()).toEqual([...ALLOWED].sort());
  });
});
