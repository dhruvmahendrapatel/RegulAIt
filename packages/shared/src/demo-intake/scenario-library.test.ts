import { describe, it, expect } from "vitest";
import { SCENARIO_LIBRARY } from "./scenario-library.js";
import { AI_RISK_CATEGORIES } from "../risks.js";
import { INTAKE_SECTORS } from "../intake-assist.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";

describe("SCENARIO_LIBRARY", () => {
  it("has 33-40 distinct scenarios", () => {
    expect(SCENARIO_LIBRARY.length).toBeGreaterThanOrEqual(33);
    expect(SCENARIO_LIBRARY.length).toBeLessThanOrEqual(40);
  });

  it("has unique keys in kebab-case", () => {
    const keys = SCENARIO_LIBRARY.map(s => s.key);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);

    for (const key of keys) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("has unique titles and descriptions", () => {
    const titles = new Set(SCENARIO_LIBRARY.map(s => s.title));
    const desc = new Set(SCENARIO_LIBRARY.map(s => s.description));
    
    expect(titles.size).toBe(SCENARIO_LIBRARY.length);
    expect(desc.size).toBe(SCENARIO_LIBRARY.length);
  });

  it("does not use templated titles", () => {
    for (const s of SCENARIO_LIBRARY) {
      expect(s.title).not.toMatch(/^Potential .* risk \d+$/);
    }
  });

  it("covers all domains in INTAKE_SECTORS", () => {
    const domainsUsed = new Set<string>();
    for (const s of SCENARIO_LIBRARY) {
      for (const d of s.domains) {
        domainsUsed.add(d);
      }
    }
    
    for (const domain of INTAKE_SECTORS) {
      expect(domainsUsed.has(domain)).toBe(true);
    }
  });

  it("covers every risk category at least 3 times", () => {
    const counts: Record<string, number> = {};
    for (const cat of AI_RISK_CATEGORIES) {
      counts[cat] = 0;
    }
    
    for (const s of SCENARIO_LIBRARY) {
      if (counts[s.category] !== undefined) {
        counts[s.category]++;
      }
    }
    
    for (const cat of AI_RISK_CATEGORIES) {
      expect(counts[cat]).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses valid compliance controlRefs", () => {
    const validRefs = new Set();
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      for (const ctrl of pack.controls) validRefs.add(ctrl.controlRef);
    }
    
    for (const s of SCENARIO_LIBRARY) {
      expect(s.suggestedControls.length).toBeGreaterThanOrEqual(2);
      expect(s.suggestedControls.length).toBeLessThanOrEqual(4);
      for (const ref of s.suggestedControls) {
        expect(validRefs.has(ref)).toBe(true);
      }
    }
  });
});
