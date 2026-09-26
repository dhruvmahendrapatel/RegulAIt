/**
 * INDEPENDENT check by the reviewing session, with numbers the author never used.
 *
 * The honesty spine of ADR-0069 is that "we saw the call" and "we were told"
 * must never be added together. A comment promising that is worth nothing; this
 * walks the ENTIRE returned structure — every number at every depth — and fails
 * if the blend is present anywhere, including spelled inside a sentence.
 *
 * Chosen so the blend is unmistakable: 13.13 + 86.87 = 100.00 exactly, and 100
 * is a value nothing else here would produce by coincidence.
 */
import { describe, it, expect } from "vitest";
import { consolidate } from "@regulait/shared";

const METERED = 13.13;
const IMPORTED = 86.87;
const BLEND = 100; // the number that must not exist

function everyNumber(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number") out.push(v);
  else if (typeof v === "string") for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) out.push(Number(m));
  else if (Array.isArray(v)) for (const x of v) everyNumber(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) everyNumber(x, out);
  return out;
}

function everyKey(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) everyKey(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { out.push(k); everyKey(x, out); }
  }
  return out;
}

const result = consolidate({
  by: "user",
  metered: [{ userId: "u1", costCenter: "cc1", costUsd: METERED }],
  imported: [
    { userId: "u1", costCenter: "cc1", vendor: "acme", amount: IMPORTED, currency: "USD", billingKind: "seat" as never },
  ],
});

describe("ADVERSARIAL: metered and imported are never added together", () => {
  it("the blend appears NOWHERE in the response, at any depth or inside prose", () => {
    const nums = everyNumber(result);
    expect(nums).toContain(METERED);
    expect(nums).toContain(IMPORTED); // both halves really are reported
    expect(nums).not.toContain(BLEND);
  });

  it("no field is named like a blend", () => {
    const keys = everyKey(result).map((k) => k.toLowerCase());
    for (const bad of ["total", "combined", "grandtotal", "allusd", "sum", "overall"]) {
      expect(keys).not.toContain(bad);
    }
  });

  it("states its basis in words, so a reader cannot mistake one for the other", () => {
    expect(result.basisStatement).toMatch(/metered/i);
    expect(result.basisStatement).toMatch(/imported/i);
  });
});
