import { describe, it, expect } from "vitest";
import { REGULATORY_UPDATES } from "./regulatory-updates.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";
import { COMPLIANCE_PACK_FRAMEWORKS } from "../compliance-packs.js";
import { REGULATORY_UPDATE_STATUSES } from "../regulatory-intel.js";

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
      if (u.status === "in_force") {
        expect(effective, `'${u.key}' is in_force but effectiveDate is after verifiedOn`).toBeLessThanOrEqual(verified);
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
