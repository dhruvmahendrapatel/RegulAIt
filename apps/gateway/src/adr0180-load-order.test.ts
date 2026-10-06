/**
 * ADR-0180 (D3, FA10) — the gateway's modules LOAD, each as the first module
 * of a fresh Node process, under real ESM semantics.
 *
 * Why the built files and a child process: an import cycle only fails when a
 * module in it reads another's binding at load time before that module has
 * run (a temporal-dead-zone ReferenceError). Vitest's own loader does not
 * reproduce Node's evaluation order, so the check runs the BUILT modules (CI
 * builds before testing, as `seed.test.ts` relies on) in plain Node.
 *
 * The regression this pins: A10 made `risks.ts` import `risk-tolerance.ts`,
 * which imported `review-policy.ts` (→ workflows → evals → … → mrm →
 * mrm-autofill) and `governance-monitor.ts` (→ autonomy → mrm …) at module
 * level. `mrm-autofill` reads `INVENTORY_WINDOW_DAYS` at load, so importing
 * `inventory.js` first died with "Cannot access 'INVENTORY_WINDOW_DAYS' before
 * initialization", and `demo:prepare` with it.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

/** library modules on the cycle (none runs anything at load) */
const ENTRY_MODULES = [
  "inventory",
  "governance-monitor",
  "risks",
  "risk-tolerance",
  "review-policy",
  "autonomy",
  "mrm",
  "mrm-autofill",
  "dependency-graph",
  "scheduler-jobs",
  "app",
  // ADR-0182 (D4): each slice's module and P0's, loaded first. The monitor and
  // the scheduler import the slice modules, so a slice that later imports the
  // monitor (or anything on its cycle) at load time is caught here.
  "decision-regression",
  "incidents",
  "feedback",
  "ai-literacy",
  "alert-ownership",
  "eu-ai-act-role",
  "execution-control",
  // the D4 security review's evidence hold at every agent-config write (DFX2), and the module that brought it onto
  // inventory's import chain
  "agent-evidence-hold",
  "config-versions",
];

function loadAlone(mod: string): string | null {
  const file = path.join(dist, `${mod}.js`);
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(file)});`], {
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return null;
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer }).stderr ?? e);
    return stderr.split("\n").find((l) => /Error/.test(l)) ?? stderr.slice(0, 500);
  }
}

describe("FA10: the gateway's modules load in any entry order (no ESM import-cycle TDZ)", () => {
  it("has a build to load", () => {
    expect(existsSync(path.join(dist, "inventory.js")), `build the gateway first (${dist})`).toBe(true);
  });

  it.each(ENTRY_MODULES)("%s.js loads first in a fresh process", (mod) => {
    expect(loadAlone(mod)).toBeNull();
  }, 60_000);
});
