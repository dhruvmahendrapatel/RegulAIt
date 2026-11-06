import { describe, expect, it } from "vitest";
import { watermarkProblems } from "./migration-watermark-guard.mjs";

const j = (...es) => ({ entries: es.map(([tag, when]) => ({ tag, when })) });

describe("migration watermark guard", () => {
  it("passes a new entry above the base watermark", () => {
    expect(watermarkProblems(j(["0237_a", 1785172000000]), j(["0237_a", 1785172000000], ["0231_b", 1785173000000]))).toEqual([]);
  });
  it("refuses a new entry below the base watermark, as merged out of number order", () => {
    const p = watermarkProblems(j(["0237_a", 1785172000000]), j(["0231_b", 1785166000000], ["0237_a", 1785172000000]));
    expect(p.some((l) => l.startsWith("0231_b:"))).toBe(true);
  });
  it("refuses a journal whose when values do not strictly increase", () => {
    const p = watermarkProblems(j(["0214_a", 1785149000000]), j(["0214_a", 1785149000000], ["0238_b", 1785174000000], ["0239_c", 1785174000000]));
    expect(p.some((l) => l.startsWith("0239_c:"))).toBe(true);
  });
  it("ignores entries already on the base branch", () => {
    expect(watermarkProblems(j(["0230_a", 1785165000000], ["0237_b", 1785172000000]), j(["0230_a", 1785165000000], ["0237_b", 1785172000000]))).toEqual([]);
  });
});
