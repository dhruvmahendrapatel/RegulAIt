import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPETITIVE_ASK_OPTIONS,
  REPETITIVE_ASK_LIMITS,
  askFingerprint,
  findRepetitiveAsks,
  repetitiveAskOptionProblems,
  type Ask,
} from "./repetitive-asks.js";

const TOPICS = [
  "explain quantum entanglement to a physics student",
  "draft a cover letter for a nursing job in Leeds",
  "write a haiku about autumn leaves falling",
  "compare postgres and mysql replication options",
  "list three causes of the French revolution",
  "translate good morning into Portuguese and Spanish",
  "suggest a vegetarian dinner menu for six people",
  "debug a null pointer exception in this Java snippet",
];

/** one template asked again and again, only an id changing: the shape a smaller model can take over */
const templated = (n: number, from = 0): Ask[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${from + i}`,
    text: `Summarise support ticket ${1000 + from + i} for the weekly report: customer cannot reset password, include priority and owner`,
    costUsd: 0.01,
  }));

const distinct = (): Ask[] => TOPICS.map((t, i) => ({ id: `d${i}`, text: t, costUsd: 0.05 }));

const bitsApart = (a: string, b: string) => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
};

describe("ADR-0328 slice 1: repetitive asks", () => {
  it("fingerprints are stable, 64-bit, and close for near-duplicates but far for unrelated asks", () => {
    const a = askFingerprint("Summarise support ticket 1001 for the weekly report: customer cannot reset password");
    const b = askFingerprint("Summarise support ticket 1002 for the weekly report: customer cannot reset password");
    const c = askFingerprint("write a haiku about autumn leaves falling");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(askFingerprint("Summarise support ticket 1001 for the weekly report: customer cannot reset password")).toBe(a);
    expect(bitsApart(a, b)).toBeLessThanOrEqual(DEFAULT_REPETITIVE_ASK_OPTIONS.maxHamming);
    expect(bitsApart(a, c)).toBeGreaterThan(DEFAULT_REPETITIVE_ASK_OPTIONS.maxHamming);
    expect(askFingerprint("a of the")).toBe("");
  });

  it("finds one cluster for a template asked again and again, and none among distinct asks", () => {
    const asks = [...templated(30), ...distinct()];
    const r = findRepetitiveAsks(asks);
    expect(r.clusters).toHaveLength(1);
    const [c] = r.clusters;
    expect(c!.size).toBe(30);
    expect([...c!.memberIds].sort()).toEqual(templated(30).map((a) => a.id).sort());
    expect(c!.memberIds).toContain(c!.representativeId);
    expect(c!.cohesion).toBeGreaterThanOrEqual(DEFAULT_REPETITIVE_ASK_OPTIONS.minSimilarity);
    expect(c!.totalCostUsd).toBeCloseTo(0.3, 6);
    expect(c!.meanCostUsd).toBeCloseTo(0.01, 6);
    expect(r.considered).toBe(38);
    expect(findRepetitiveAsks(distinct(), { minClusterSize: 2 }).clusters).toHaveLength(0);
  });

  it("is privacy-safe: the result holds ids, fingerprints and counts, never prompt text", () => {
    const r = JSON.stringify(findRepetitiveAsks([...templated(25), ...distinct()]));
    for (const word of ["Summarise", "summarise", "password", "ticket", "haiku", "weekly"]) expect(r).not.toContain(word);
  });

  it("holds the strict floors: a cluster below the size floor, or wording below the similarity floor, is not reported", () => {
    expect(findRepetitiveAsks(templated(19)).clusters).toHaveLength(0);
    expect(findRepetitiveAsks(templated(19), { minClusterSize: 19 }).clusters).toHaveLength(1);
    // same topic, different wording each time: a topic is not a template
    const paraphrases: Ask[] = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      text: `${["please", "kindly", "could you", "quickly", "now"][i % 5]} ${["summarise", "condense", "recap", "shorten", "digest"][(i * 3) % 5]} the ${["ticket", "case", "issue", "request", "report"][(i * 7) % 5]} ${i}`,
    }));
    expect(findRepetitiveAsks(paraphrases).clusters).toHaveLength(0);
  });

  it("confirms each pair by wording too: fingerprints a few bits apart are not enough on their own", () => {
    // two templates one word apart: 6 fingerprint bits apart, so a wide Hamming bound pairs them; the cosine floor keeps
    // them apart
    const variant = (word: string, from: number): Ask[] =>
      Array.from({ length: 25 }, (_, i) => ({
        id: `${word}${i}`,
        text: `Summarise support ticket ${from + i} for the weekly report: customer cannot reset password, include priority and ${word}`,
      }));
    const asks = [...variant("owner", 100), ...variant("manager", 500)];
    expect(findRepetitiveAsks(asks, { maxHamming: 7, minSimilarity: 0.99 }).clusters.map((c) => c.size)).toEqual([25, 25]);
  });

  it("is deterministic and orders clusters largest first", () => {
    const other: Ask[] = Array.from({ length: 22 }, (_, i) => ({ id: `o${i}`, text: `Classify invoice ${5000 + i} from the supplier portal as paid, overdue or disputed` }));
    const asks = [...other, ...templated(40)];
    const a = findRepetitiveAsks(asks);
    expect(a).toEqual(findRepetitiveAsks(asks));
    expect(a.clusters.map((c) => c.size)).toEqual([40, 22]);
    expect(a.clusters[1]!.totalCostUsd).toBeNull();
  });

  it("is bounded, and refuses options outside their range", () => {
    const r = findRepetitiveAsks(templated(REPETITIVE_ASK_LIMITS.maxAsks + 10));
    expect(r.truncated).toBe(10);
    expect(r.considered).toBe(REPETITIVE_ASK_LIMITS.maxAsks);
    // one template: every band bucket is larger than the cap, and the rest still join through its first member
    expect(r.cappedBuckets).toBeGreaterThan(0);
    expect(r.clusters[0]!.size).toBe(REPETITIVE_ASK_LIMITS.maxAsks);
    expect(repetitiveAskOptionProblems({ maxHamming: 8, minSimilarity: 1.2, minClusterSize: 1 })).toHaveLength(3);
    expect(() => findRepetitiveAsks([], { maxHamming: -1 })).toThrow(RangeError);
  });
});
