/**
 * ADR-0319 (gap G11) — the AIUC-1 ID-only pack.
 *
 *  1. It parses, is seeded once, is in the picker vocabulary, claims no review, conformity or certification, and is pinned.
 *  2. Every live requirement of the 15 October 2026 release is mapped exactly once; retired ones are not.
 *  3. Titles cite the identifier; attested controls use `none` and say what to attest; third-party testing is never
 *     auto-evidenced; each requirement takes its principle's trust dimension.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AIUC_1_CONTROLS, AIUC_1_PACK, AIUC_1_RETIRED, AIUC_1_SOURCE, AIUC_PACKS } from "./aiuc-packs.js";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { dimensionForControl } from "./trust-dimensions.js";

const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const idOf = (ref: string) => /^aiuc-1:([A-F]\d{3})-[a-z0-9-]+$/.exec(ref)?.[1];

/** the live requirement index of the 15 October 2026 release, as published */
const range = (letter: string, from: number, to: number, skip: number[] = []) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .filter((n) => !skip.includes(n))
    .map((n) => `${letter}${String(n).padStart(3, "0")}`);
const LIVE = [
  ...range("A", 1, 9),
  ...range("B", 1, 10),
  ...range("C", 1, 10),
  ...range("D", 1, 4, [2]),
  ...range("E", 1, 18, [7, 14]),
  ...range("F", 1, 2),
];
const THIRD_PARTY = ["A009", "B001", "C010", "D004", "E018"];

describe("schema, seed and pin", () => {
  it("parses, is seeded once, is in the picker vocabulary and claims no review, conformity or certification", () => {
    createCompliancePackSchema.parse(AIUC_1_PACK);
    expect(DEFAULT_COMPLIANCE_PACKS.filter((p) => p.framework === "aiuc-1")).toHaveLength(1);
    expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain("aiuc-1");
    expect(AIUC_1_PACK.provenance.reviewedBy).toBeNull();
    expect(AIUC_1_PACK.provenance.source).toContain(AIUC_1_SOURCE.url);
    expect(AIUC_1_PACK.provenance.catalogueRevision).toMatch(/15 October 2026/);
    expect(JSON.stringify(AIUC_1_PACK.controls)).not.toMatch(/\b(compliant|conformant|certified)\b/i);
  });

  it("is pinned: a published version is never edited (ADR-0058)", () => {
    expect(Object.fromEntries(AIUC_PACKS.map((p) => [`${p.framework}@${p.version}`, digest(p)]))).toEqual({
      "aiuc-1@1": "6205fb5a45ba77a61ecb757721e4270f7d1d9c829c6e6fd690e9409cb55e8322",
    });
  });
});

describe("every live requirement, once; no retired one", () => {
  it("maps exactly the 50 live requirements of the 15 October 2026 release", () => {
    const ids = AIUC_1_CONTROLS.map((c) => idOf(c.controlRef));
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LIVE).toHaveLength(50);
    expect([...ids].sort()).toEqual([...LIVE].sort());
  });

  it("maps no retired requirement", () => {
    expect(AIUC_1_RETIRED).toEqual(["C011", "C012", "D002", "E007", "E014"]);
    for (const r of AIUC_1_RETIRED) expect(AIUC_1_CONTROLS.map((c) => idOf(c.controlRef))).not.toContain(r);
  });
});

describe("citations and honest coverage", () => {
  it("every title cites its identifier, and the ref carries the same identifier", () => {
    for (const c of AIUC_1_CONTROLS) expect(c.title, c.controlRef).toBe(`AIUC-1 ${idOf(c.controlRef)} — ${c.title.split(" — ")[1]}`);
  });

  it("attested controls use `none` and say what to attest; evidenced ones name what they count", () => {
    for (const c of AIUC_1_CONTROLS) {
      if (c.attestationRequired) {
        expect(c.collector, c.controlRef).toBe("none");
        expect(c.ownerNote, c.controlRef).toMatch(/Attest /);
      } else {
        expect(c.collector, c.controlRef).not.toBe("none");
        expect(c.coverage, c.controlRef).not.toBe("unaddressed");
        expect(c.ownerNote, c.controlRef).toBeTruthy();
      }
    }
  });

  it("third-party testing is never evidenced by the platform's own runs", () => {
    for (const id of THIRD_PARTY) {
      const c = AIUC_1_CONTROLS.find((x) => idOf(x.controlRef) === id)!;
      expect(c.attestationRequired, id).toBe(true);
      expect(c.coverage, id).toBe("unaddressed");
      expect(c.ownerNote, id).toMatch(/independent party/);
    }
  });

  it("only the audit ledger and access recertification are claimed as enforced", () => {
    expect(AIUC_1_CONTROLS.filter((c) => c.coverage === "enforced").map((c) => idOf(c.controlRef)).sort()).toEqual(["B007", "E015"]);
  });

  it("each requirement takes its principle's trust dimension", () => {
    const want: Record<string, string> = { A: "privacy", B: "security", C: "safety", D: "reliability", E: "compliance", F: "safety" };
    for (const c of AIUC_1_CONTROLS) expect(dimensionForControl(c), c.controlRef).toBe(want[idOf(c.controlRef)!.charAt(0)]);
  });
});
