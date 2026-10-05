import { describe, it, expect } from "vitest";
import { REGULATORY_UPDATES } from "./regulatory-updates.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";
import { COMPLIANCE_PACK_FRAMEWORKS } from "../compliance-packs.js";
import { REGULATORY_INSTRUMENT_KINDS, REGULATORY_UPDATE_STATUSES, regulatoryUpdateProblems } from "../regulatory-intel.js";

describe("REGULATORY_UPDATES", () => {
  // ---------------------------------------------------------------------------
  // Count and key uniqueness
  // ---------------------------------------------------------------------------

  it("has between 10 and 14 entries", () => {
    expect(REGULATORY_UPDATES.length).toBeGreaterThanOrEqual(10);
    expect(REGULATORY_UPDATES.length).toBeLessThanOrEqual(14);
  });

  it("has unique keys", () => {
    const keys = REGULATORY_UPDATES.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys are kebab-case", () => {
    for (const u of REGULATORY_UPDATES) {
      expect(u.key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  // ---------------------------------------------------------------------------
  // Date format
  // ---------------------------------------------------------------------------

  it("effectiveDate values parse as valid ISO dates", () => {
    for (const u of REGULATORY_UPDATES) {
      const d = new Date(u.effectiveDate);
      expect(isNaN(d.getTime()), `effectiveDate '${u.effectiveDate}' on '${u.key}' is not a valid date`).toBe(false);
      expect(u.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("verifiedOn values parse as valid ISO dates", () => {
    for (const u of REGULATORY_UPDATES) {
      const d = new Date(u.verifiedOn);
      expect(isNaN(d.getTime()), `verifiedOn '${u.verifiedOn}' on '${u.key}' is not a valid date`).toBe(false);
      expect(u.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  // ---------------------------------------------------------------------------
  // Source URLs
  // ---------------------------------------------------------------------------

  it("every entry has an HTTPS sourceUrl", () => {
    for (const u of REGULATORY_UPDATES) {
      expect(u.sourceUrl.startsWith("https://"), `sourceUrl '${u.sourceUrl}' on '${u.key}' is not HTTPS`).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Status values
  // ---------------------------------------------------------------------------

  it("status values are one of the allowed enum values", () => {
    const allowed = new Set<string>(REGULATORY_UPDATE_STATUSES);
    for (const u of REGULATORY_UPDATES) {
      expect(allowed.has(u.status), `invalid status '${u.status}' on '${u.key}'`).toBe(true);
    }
  });

  it("status matches the relationship between effectiveDate and verifiedOn", () => {
    for (const u of REGULATORY_UPDATES) {
      const effective = new Date(u.effectiveDate).getTime();
      const verified = new Date(u.verifiedOn).getTime();
      if (u.status === "in_force" || u.status === "published" || u.status === "withdrawn") {
        expect(effective, `'${u.key}' is ${u.status} but effectiveDate is after verifiedOn`).toBeLessThanOrEqual(verified);
      } else if (u.status === "upcoming") {
        expect(effective, `'${u.key}' is upcoming but effectiveDate is before or on verifiedOn`).toBeGreaterThan(verified);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Framework ids
  // ---------------------------------------------------------------------------

  it("framework ids exist in COMPLIANCE_PACK_FRAMEWORKS", () => {
    const validFrameworks = new Set<string>(COMPLIANCE_PACK_FRAMEWORKS);
    for (const u of REGULATORY_UPDATES) {
      for (const fw of u.frameworks) {
        expect(validFrameworks.has(fw), `framework '${fw}' on '${u.key}' is not in COMPLIANCE_PACK_FRAMEWORKS`).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Control refs
  // ---------------------------------------------------------------------------

  it("controlRefs exist in DEFAULT_COMPLIANCE_PACKS", () => {
    const validRefs = new Set<string>();
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      for (const ctrl of pack.controls) validRefs.add(ctrl.controlRef);
    }
    for (const u of REGULATORY_UPDATES) {
      for (const ref of u.controlRefs) {
        expect(validRefs.has(ref), `controlRef '${ref}' on '${u.key}' is not in DEFAULT_COMPLIANCE_PACKS`).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Content completeness
  // ---------------------------------------------------------------------------

  it("every entry has a non-empty title, summary, instrument, and jurisdiction", () => {
    for (const u of REGULATORY_UPDATES) {
      expect(u.title.length, `empty title on '${u.key}'`).toBeGreaterThan(0);
      expect(u.summary.length, `empty summary on '${u.key}'`).toBeGreaterThan(0);
      expect(u.instrument.length, `empty instrument on '${u.key}'`).toBeGreaterThan(0);
      expect(u.jurisdiction.length, `empty jurisdiction on '${u.key}'`).toBeGreaterThan(0);
    }
  });
});

// ADR-0179 G14-FEED: the factual corrections, pinned per entry so a later edit
// cannot quietly reintroduce a withdrawn circular as current, a voluntary
// standard as law in force, or an enforcement date as the effective date.
describe("REGULATORY_UPDATES — G14-FEED reconciliation", () => {
  const byKey = (key: string) => {
    const u = REGULATORY_UPDATES.find((x) => x.key === key);
    expect(u, `missing entry '${key}'`).toBeDefined();
    return u!;
  };

  it("every entry satisfies the feed consistency rules", () => {
    expect(REGULATORY_UPDATES.flatMap(regulatoryUpdateProblems)).toEqual([]);
  });

  it("every entry names an instrument kind", () => {
    for (const u of REGULATORY_UPDATES) {
      expect(REGULATORY_INSTRUMENT_KINDS as readonly string[], `'${u.key}'`).toContain(u.instrumentKind);
    }
  });

  it("CFPB Circular 2022-03 is withdrawn guidance, withdrawn on 2025-05-12, sourced to the withdrawal register", () => {
    const u = byKey("cfpb-adverse-action-ai");
    expect(u).toMatchObject({ status: "withdrawn", instrumentKind: "guidance", withdrawnOn: "2025-05-12", effectiveDate: "2022-05-26" });
    expect(u.sourceUrl).toBe("https://www.consumerfinance.gov/compliance/guidance/withdrawn-guidance/");
    expect(u.summary).toContain("pending legal review");
  });

  it("NYC Local Law 144 separates its effective date (2023-01-01) from enforcement (2023-07-05)", () => {
    const u = byKey("nyc-local-law-144");
    expect(u).toMatchObject({ instrumentKind: "law", status: "in_force", effectiveDate: "2023-01-01", enforcementDate: "2023-07-05" });
    expect(u.sourceUrl).toContain("GUID=B051915D-A9AC-451E-81F8-6596032FA3F9");
  });

  it("NIST AI RMF, NIST AI 600-1 and ISO/IEC 42001 are voluntary standards: published, never in force", () => {
    for (const key of ["nist-ai-rmf-1-0", "nist-ai-rmf-genai-profile", "iso-42001-published"]) {
      expect(byKey(key)).toMatchObject({ instrumentKind: "voluntary_standard", status: "published" });
    }
    const voluntaryInForce = REGULATORY_UPDATES.filter((u) => u.instrumentKind === "voluntary_standard" && u.status === "in_force");
    expect(voluntaryInForce.map((u) => u.key)).toEqual([]);
  });

  it("keeps the source-supported EU Digital Omnibus dates", () => {
    expect(byKey("eu-digital-omnibus-on-ai").effectiveDate).toBe("2026-07-27");
    expect(byKey("eu-ai-act-high-risk-annex-iii-in-force").effectiveDate).toBe("2027-12-02");
    expect(byKey("eu-ai-act-high-risk-annex-i-in-force").effectiveDate).toBe("2028-08-02");
  });

  it("reconciles all 13 entries: counts by status and by instrument kind", () => {
    const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
    expect(REGULATORY_UPDATES).toHaveLength(13);
    expect(tally(REGULATORY_UPDATES.map((u) => u.status))).toEqual({ in_force: 6, upcoming: 3, published: 3, withdrawn: 1 });
    expect(tally(REGULATORY_UPDATES.map((u) => u.instrumentKind))).toEqual({ law: 9, guidance: 1, voluntary_standard: 3 });
  });

  it("a withdrawal date is never later than the date the entry was verified", () => {
    for (const u of REGULATORY_UPDATES) {
      if (u.withdrawnOn) expect(u.withdrawnOn <= u.verifiedOn, `'${u.key}'`).toBe(true);
    }
  });
});
