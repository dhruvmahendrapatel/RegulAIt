/**
 * ADR-0189 B1 — wall-clock budgets for every pattern check the BOM contract runs
 * on caller input (CodeQL js/polynomial-redos). Serialized in the `timing`
 * project (vitest.config.ts TIMING_FILES) so the budget measures this code, not
 * its neighbours. Each case is 100k characters of the repetition CodeQL named,
 * with a tail that makes the input fail.
 */
import { describe, expect, it } from "vitest";
import {
  bomEndpointSchema,
  bomIdentifierSchema,
  bomSpiffeSchema,
  findEmailShapes,
  hasEmailShape,
  isBomDottedOid,
  isBomExportEndpoint,
  isBomSpiffeId,
  parseTrainingDatasetChecksum,
} from "./contract.js";

const N = 100_000;
function budget(label: string, run: () => unknown, ms = 50) {
  const t0 = performance.now();
  run();
  expect(performance.now() - t0, label).toBeLessThan(ms);
}

describe("linear pattern checks on 100k adversarial characters", () => {
  it("the email scan (both CodeQL fingerprints: '!' and '-' repetitions)", () => {
    for (const evil of [
      "!".repeat(N) + "@",
      "!".repeat(N) + "@a",
      "a@".repeat(N / 2) + "!",
      "!@".repeat(N / 2),
      "@" + "a.".repeat(N / 2) + "!",
      "x@" + "-".repeat(N) + "!",
      ("x@" + "-".repeat(1000)).repeat(N / 1002),
      "-".repeat(N) + "@" + "-".repeat(N),
    ]) {
      budget(evil.slice(0, 12), () => {
        expect(hasEmailShape(evil)).toBe(false);
        expect(findEmailShapes({ [evil.slice(0, 50)]: evil })).toEqual([]);
      });
    }
  });
  it("SPIFFE ids, endpoints, OIDs and identifiers", () => {
    const cases: Array<[string, () => boolean]> = [
      ["spiffe host '-'", () => isBomSpiffeId("spiffe://" + "-".repeat(N) + "!")],
      ["spiffe segments", () => isBomSpiffeId("spiffe://td" + "/a".repeat(N / 2) + "/")],
      ["spiffe schema", () => bomSpiffeSchema.safeParse("spiffe://" + "-".repeat(N) + "!").success],
      ["endpoint host '-'", () => isBomExportEndpoint("https://" + "-".repeat(N) + "!")],
      ["endpoint path", () => isBomExportEndpoint("https://h" + "/-".repeat(N / 2) + "?")],
      ["endpoint schema", () => bomEndpointSchema.safeParse("https://h" + "/".repeat(N) + "#").success],
      ["oid arcs", () => isBomDottedOid("1" + ".1".repeat(N / 2) + ".")],
      ["identifier '-'", () => bomIdentifierSchema.safeParse("-".repeat(N) + " ").success],
      ["checksum digits", () => { try { parseTrainingDatasetChecksum("sha256:" + "a".repeat(64) + ":" + "9".repeat(N)); return true; } catch { return false; } }],
    ];
    for (const [label, run] of cases) budget(label, () => expect(run()).toBe(false));
  });
});
