// #738 (review O-01): every production dependency has a THIRD_PARTY.md row at its lockfile version.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cellNames, parseRows, thirdPartyProblems } from "./preflight-third-party.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "preflight-third-party.mjs");
let roots = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** a workspace with one package `packages/p` whose dependencies are `deps` (name -> lockfile version) */
function fixture(deps, thirdParty) {
  const root = mkdtempSync(path.join(tmpdir(), "third-party-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/p"), { recursive: true });
  const dependencies = Object.fromEntries(Object.keys(deps).map((n) => [n, deps[n]]));
  dependencies["@x/internal"] = "workspace:*";
  writeFileSync(path.join(root, "packages/p/package.json"), JSON.stringify({ name: "p", dependencies }));
  const lockDeps = Object.entries(deps)
    .map(([n, v]) => `      '${n}':\n        specifier: ${v}\n        version: ${v}(peer@1.0.0)`)
    .join("\n");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\nimporters:\n  packages/p:\n    dependencies:\n${lockDeps}\n`);
  if (thirdParty !== undefined) writeFileSync(path.join(root, "packages/p/THIRD_PARTY.md"), thirdParty);
  return root;
}
const table = (rows) => `| Package | Version | Licence | Why |\n|---|---|---|---|\n${rows.join("\n")}\n`;
const run = (root) => {
  try {
    execFileSync("node", [script, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
};

describe("preflight-third-party", () => {
  it("the repository itself is complete (non-vacuous: it has production dependencies)", () => {
    expect(thirdPartyProblems(path.join(here, ".."))).toEqual([]);
    expect(run(path.join(here, ".."))).toBe(0);
  });

  it("passes when every dependency has a row naming its lockfile version; workspace deps need none", () => {
    const root = fixture({ zod: "4.6.7" }, table(["| `zod` | `4.6.7` (pinned) | MIT | why |"]));
    expect(thirdPartyProblems(root)).toEqual([]);
    expect(run(root)).toBe(0);
  });

  it("fails on a missing row, a missing file and a stale version", () => {
    expect(thirdPartyProblems(fixture({ zod: "4.6.7", jose: "6.2.14" }, table(["| `zod` | 4.6.7 | MIT | why |"])))).toEqual([
      { dir: "packages/p", name: "jose", version: "6.2.14", kind: "missing" },
    ]);
    expect(thirdPartyProblems(fixture({ zod: "4.6.7" }, undefined))).toHaveLength(1);
    const stale = fixture({ zod: "4.6.8" }, table(["| `zod` | 4.6.7 | MIT | why |"]));
    expect(thirdPartyProblems(stale)).toEqual([{ dir: "packages/p", name: "zod", version: "4.6.8", kind: "version", cell: "4.6.7" }]);
    expect(run(stale)).toBe(1);
  });

  it("matches a version as a whole token only", () => {
    expect(cellNames("1.2.3 (released 2026-10-01)", "1.2.3")).toBe(true);
    expect(cellNames("`1.2.3`", "1.2.3")).toBe(true);
    expect(cellNames("11.2.3", "1.2.3")).toBe(false);
    expect(cellNames("1.2.30", "1.2.3")).toBe(false);
    expect(cellNames("1.2.3.4", "1.2.3")).toBe(false);
  });

  it("reads rows by the backticked name in the first cell and leaves other rows alone", () => {
    const rows = parseRows(table(["| `a` (npm, © x) | 1.0.0 | MIT | y |", "| gitleaks ruleset (`config/x`) | commit abc | MIT | z |"]));
    expect([...rows.keys()]).toEqual(["a"]);
  });

  it("fails closed when the lockfile is missing", () => {
    const root = fixture({ zod: "4.6.7" }, table([]));
    rmSync(path.join(root, "pnpm-lock.yaml"));
    expect(run(root)).toBe(2);
  });
});
