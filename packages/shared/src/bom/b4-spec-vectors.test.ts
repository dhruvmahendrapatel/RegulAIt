/**
 * ADR-0189 B4 specification-only verifier vectors
 * (`packages/shared/test-vectors/decision-bom/`, adopted from PR #312, X46).
 *
 * Runs the vectors' own checker so CI keeps them honest: every digest, tar
 * digest and signature in them must still hold, each negative must still break
 * exactly the layer it names, P01 must still equal ADR-0189 B4.6 byte for byte,
 * and the finality and required-checks expectations must still agree with a
 * reference reading of B4.4 and B4.5. A second run on a deliberately corrupted
 * copy proves the checker is not vacuous.
 *
 * This file tests the VECTORS, not B4: it imports nothing from `src/`. B4's own
 * verifier tests consume `b4-vectors.json` (see that directory's README).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = path.resolve(here, "../../test-vectors/decision-bom");
const checker = path.join(vectorsDir, "check-vectors.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [checker, ...args], { encoding: "utf8", timeout: 60_000 });

describe("ADR-0189 B4 specification-only verifier vectors", () => {
  it("every vector is well formed and self-consistent", () => {
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^PASS \d+ checks/);
  });

  it("the checker fails on a corrupted vector (a positive whose body byte changed)", () => {
    const corpus = JSON.parse(readFileSync(path.join(vectorsDir, "b4-vectors.json"), "utf8")) as {
      positives: Array<{ id: string; bundle: { entries: Array<{ name: string; text: string }> } }>;
    };
    const p07 = corpus.positives.find((p) => p.id === "P07")!;
    const body = p07.bundle.entries.find((e) => e.name.endsWith("/content/decision-bom.json"))!;
    body.text = body.text.replace('"inputTokens":113', '"inputTokens":114');
    const dir = mkdtempSync(path.join(tmpdir(), "b4-vectors-"));
    try {
      const file = path.join(dir, "b4-vectors.json");
      writeFileSync(file, JSON.stringify(corpus));
      const r = run("--vectors", file);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("P07 tar bytes");
      expect(r.stderr).toContain("P07 every layer verifies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
