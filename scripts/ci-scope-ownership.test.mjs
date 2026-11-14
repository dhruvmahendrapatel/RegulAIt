// #738 Lane A: the CI scope (scripts/ci-scope.mjs, its test, .github/actions/) decides whether CodeQL and Trivy run
// on a PR, so it is owner-reviewed (CODEOWNERS) and a change to it is flagged as a security-gate change (security.yml
// WATCHED). This test keeps both lists from losing those paths.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(repo, p), "utf8");
const SCOPE_PATHS = [".github/actions/", "scripts/ci-scope.mjs", "scripts/ci-scope.test.mjs"];

describe("the CI scope is owner-reviewed and watched as a security gate", () => {
  it("CODEOWNERS names the owner for each scope path", () => {
    const owned = read(".github/CODEOWNERS")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.trim().split(/\s+/))
      .filter(([, ...owners]) => owners.includes("@dhruvmahendrapatel"))
      .map(([p]) => p.replace(/^\//, ""));
    for (const p of SCOPE_PATHS) expect(owned, p).toContain(p);
  });

  it("security.yml's WATCHED list includes each scope path", () => {
    const steps = Object.values(yaml.load(read(".github/workflows/security.yml")).jobs).flatMap((j) => j.steps ?? []);
    const watched = steps.find((s) => s.env?.WATCHED)?.env.WATCHED.split(/\s+/);
    expect(watched).toBeDefined();
    for (const p of SCOPE_PATHS) expect(watched, p).toContain(p);
  });
});
