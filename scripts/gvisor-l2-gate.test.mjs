import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIRED_TITLES, checkRunscReport } from "./gvisor-l2-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const report = (results) => ({
  numTotalTests: results.length,
  numPassedTests: results.filter((r) => r.status === "passed").length,
  numFailedTests: results.filter((r) => r.status === "failed").length,
  numPendingTests: results.filter((r) => r.status === "skipped" || r.status === "pending").length,
  numTodoTests: 0,
  testResults: [{ assertionResults: results }],
});
const all = () => REQUIRED_TITLES.map((title) => ({ title, status: "passed" }));

describe("gVisor L2 gate (#385 review L1): every required control, by title", () => {
  it("passes when all three controls ran and passed", () => {
    expect(checkRunscReport(report(all()))).toEqual([]);
  });

  it("fails when a negative control is deleted, though the count still reads 2 of 2 passed", () => {
    for (const dropped of REQUIRED_TITLES) {
      const problems = checkRunscReport(report(all().filter((r) => r.title !== dropped)));
      expect(problems).toEqual([`required control missing: ${dropped}`]);
    }
  });

  it("fails when a control is skipped or failed", () => {
    const skipped = all().map((r, i) => (i === 1 ? { ...r, status: "skipped" } : r));
    expect(checkRunscReport(report(skipped))).toEqual([
      "the runsc integration tests did not all run: 2 passed of 3, 1 skipped",
      `required control did not pass (skipped): ${REQUIRED_TITLES[1]}`,
    ]);
    const failed = all().map((r, i) => (i === 2 ? { ...r, status: "failed" } : r));
    expect(checkRunscReport(report(failed))).toContain(`required control did not pass (failed): ${REQUIRED_TITLES[2]}`);
  });

  it("fails an empty report", () => {
    expect(checkRunscReport(report([]))).toHaveLength(1 + REQUIRED_TITLES.length);
  });

  it("the required titles are the ones in the integration test file", () => {
    const src = readFileSync(path.join(root, "packages/sandbox-executor/src/runsc-backend.integration.test.ts"), "utf8");
    for (const title of REQUIRED_TITLES) expect(src).toContain(JSON.stringify(title));
  });

  it("the workflow runs this gate and pins the errnoRet refusal message (#385 review L2)", () => {
    const wf = readFileSync(path.join(root, ".github/workflows/gvisor.yml"), "utf8");
    expect(wf).toContain("node scripts/gvisor-l2-gate.mjs \"$r\"");
    expect(wf).toContain("grep -q 'errnoRet 65536 does not fit in 16 bits'");
  });
});
