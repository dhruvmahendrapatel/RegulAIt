/**
 * CodeQL js/polynomial-redos (PR #117) — the PEM-block extension in the audit
 * scrub. Audit rows can carry user input, and the old END-line regex
 * (`-----END\s+[A-Z0-9 ]*?PRIVATE…`) let `\s+` and `[A-Z0-9 ]*?` both claim the
 * same spaces, so `-----END ` followed by a long run of spaces cost O(n²).
 *
 * TIMING: that input at 50k spaces must scrub well under 100 ms.
 * EQUIVALENCE: the new END pattern finds the same span as the old one (kept
 * here as the oracle) on thousands of short random strings.
 */
import { describe, expect, it } from "vitest";
import { extendPemSpan, scrubAuditText } from "./audit-scrub.js";

const REPS = 50_000;
const BUDGET_MS = 100;
const HEADER = "-----BEGIN RSA PRIVATE KEY-----";

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** deterministic PRNG (mulberry32) so a failing case reproduces */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEGACY_PEM_END = /-----END\s+[A-Z0-9 ]*?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g;
function legacyExtend(text: string, headerEnd: number): number {
  LEGACY_PEM_END.lastIndex = headerEnd;
  const m = LEGACY_PEM_END.exec(text);
  return m ? m.index + m[0].length : text.length;
}

describe("PEM END-line search — linear time", () => {
  it("'-----END ' + spaces (the alert's input)", () => {
    const tail = "-----END " + " ".repeat(REPS);
    expect(timed(() => extendPemSpan(tail, 0))).toBeLessThan(BUDGET_MS);
    const row = `${HEADER}\nMIIEow\n${tail}`;
    let out = "";
    expect(timed(() => (out = scrubAuditText(row)))).toBeLessThan(BUDGET_MS);
    // a truncated block is scrubbed to the end of the string, as before
    expect(out).not.toContain("MIIEow");
  });

  it("other shapes of the same overlap", () => {
    for (const tail of [
      "-----END" + "\t".repeat(REPS),
      "-----END " + " A".repeat(REPS),
      "-----END PRIVATE" + " ".repeat(REPS),
      "-----END ".repeat(REPS),
    ]) {
      expect(timed(() => extendPemSpan(tail, 0))).toBeLessThan(BUDGET_MS);
    }
  });

  it("finds the same END line as the old regex", () => {
    const alphabet = ["-----END", "-----", "-", " ", "\t", "\n", "RSA", "EC", "A", "1", "a", "PRIVATE", "KEY", "BLOCK"];
    const next = rng(5);
    for (let i = 0; i < 8000; i++) {
      const parts = Math.floor(next() * 11);
      let s = "";
      for (let j = 0; j < parts; j++) s += alphabet[Math.floor(next() * alphabet.length)]!;
      const from = Math.floor(next() * (s.length + 1));
      expect(extendPemSpan(s, from), JSON.stringify([s, from])).toBe(legacyExtend(s, from));
    }
    const block = `${HEADER}\nMIIEow\n-----END RSA PRIVATE KEY-----\nafter`;
    expect(extendPemSpan(block, HEADER.length)).toBe(block.indexOf("\nafter"));
  });
});
