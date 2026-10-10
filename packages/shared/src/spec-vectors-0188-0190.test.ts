/**
 * Self-consistency of the ADR-0188 delegation and ADR-0190 placement specification vectors
 * (`packages/shared/test-vectors/{delegation,placement}`; adopts #319/#320). These tests run the
 * vector checkers only: no product code is imported, and passing them claims no product conformance.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const vectorsRoot = new URL("../test-vectors/", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

interface CheckResult {
  mutationsRejected: number;
  pending: number;
}

async function load(relative: string): Promise<Record<string, unknown>> {
  const href = new URL(relative, vectorsRoot).href;
  return (await import(href)) as Record<string, unknown>;
}

describe("ADR-0188 delegation vectors", () => {
  it("are self-consistent and every deliberate corruption is rejected", async () => {
    const mod = await load("delegation/validate.mjs");
    const run = mod["runDelegationChecks"] as () => CheckResult & { cases: number; fixtures: number };
    const result = run();
    expect(result.cases).toBeGreaterThanOrEqual(170);
    expect(result.fixtures).toBe(8);
    expect(result.pending).toBeGreaterThan(0);
    expect(result.mutationsRejected).toBe((mod["DELEGATION_MUTATIONS"] as unknown[]).length);
  });
});

describe("ADR-0190 placement vectors", () => {
  it("are self-consistent and every deliberate corruption is rejected", async () => {
    const mod = await load("placement/check-placement-corpus.mjs");
    const run = mod["runPlacementChecks"] as () => CheckResult & { vectors: number };
    const result = run();
    expect(result.vectors).toBeGreaterThanOrEqual(130);
    expect(result.pending).toBeGreaterThan(0);
    expect(result.mutationsRejected).toBe((mod["PLACEMENT_MUTATIONS"] as unknown[]).length);
  });
});

describe("secret hygiene of the vector directories", () => {
  const dirs = ["delegation", "placement"];
  // Linear: fixed prefix, bounded character classes, no nested quantifiers.
  const compactJwt = /ey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\./;

  it("stores no compact JWT-shaped string", () => {
    for (const dir of dirs) {
      for (const name of readdirSync(new URL(`${dir}/`, vectorsRoot))) {
        const text = readFileSync(new URL(`${dir}/${name}`, vectorsRoot), "utf8");
        expect(compactJwt.test(text), `${dir}/${name}`).toBe(false);
      }
    }
  });

  it("has a path-scoped CANARY allow-list entry for each directory", () => {
    const toml = readFileSync(new URL(".gitleaks.toml", repoRoot), "utf8");
    for (const dir of dirs) {
      const path = `'''^packages/shared/test-vectors/${dir}/'''`;
      const start = toml.indexOf(path);
      expect(start, dir).toBeGreaterThan(-1);
      const block = toml.slice(toml.lastIndexOf("[[allowlists]]", start), toml.indexOf("[[allowlists]]", start + 1) >>> 0);
      expect(block).toContain('condition = "AND"');
      expect(block).toContain('regexTarget = "match"');
      expect(block).toContain("regexes = ['''CANARY''']");
    }
  });
});
