/**
 * PR #378 review: `testing/step-up-posture.ts` turns step-up off (`relaxStepUpForTest`) or removes people's step-up
 * methods (`forgetStepUpMethodsForTest`). Both throw outside a test runner; this pins, statically, that no product
 * source under `apps/` or `packages/` imports them either. Test files, e2e specs, the gateway's own `testing/`
 * fixtures and archived review probes may. No database.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage", "artifacts", "test-results", "playwright-report"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/;
const NAMES = ["step-up-posture", "relaxStepUpForTest", "forgetStepUpMethodsForTest"];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
}

/** where the fixture may be named: tests, e2e specs, the gateway's own test fixtures, archived review probes */
const allowed = (rel: string) =>
  TEST.test(rel) || rel.includes("/e2e/") || rel.startsWith("apps/gateway/src/testing/") || rel.startsWith("apps/web/review/");

describe("the step-up relax helpers stay test fixtures", () => {
  it("no product source under apps/ or packages/ names them", () => {
    const files: string[] = [];
    for (const top of ["apps", "packages"]) walk(path.join(ROOT, top), files);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    let named = 0;
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const text = readFileSync(file, "utf8");
      if (!NAMES.some((n) => text.includes(n))) continue;
      named += 1;
      if (!allowed(rel)) offenders.push(rel);
    }
    expect(offenders, "product source reaches the step-up relax fixtures").toEqual([]);
    // not vacuous: the suites that use them are found
    expect(named).toBeGreaterThan(10);
  });

  it("the helpers refuse to run outside a test runner", async () => {
    const { relaxStepUpForTest, forgetStepUpMethodsForTest } = await import("./testing/step-up-posture.js");
    const saved = { vitest: process.env.VITEST, nodeEnv: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      // the guard throws before the database is touched, so no database is needed (a stub that would fail if reached)
      const db = new Proxy({}, { get: () => { throw new Error("the database was reached"); } }) as never;
      await expect(relaxStepUpForTest(db)).rejects.toThrow(/test fixture/);
      await expect(forgetStepUpMethodsForTest(db, ["00000000-0000-4000-8000-000000000001"])).rejects.toThrow(/test fixture/);
    } finally {
      if (saved.vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = saved.vitest;
      if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.nodeEnv;
    }
  });
});
