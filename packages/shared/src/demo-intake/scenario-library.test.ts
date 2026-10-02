import { describe, it, expect } from "vitest";
import { SCENARIO_LIBRARY } from "./scenario-library.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";
import { RISK_CATEGORY_DIMENSION } from "../risks.js";

describe("scenario-library", () => {
  it("has 30-40 scenarios", () => {
    expect(SCENARIO_LIBRARY.length).toBeGreaterThanOrEqual(30);
    expect(SCENARIO_LIBRARY.length).toBeLessThanOrEqual(40);
  });

  it("uses valid dimensions for categories", () => {
    for (const scenario of SCENARIO_LIBRARY) {
      expect(scenario.dimension).toBe(RISK_CATEGORY_DIMENSION[scenario.category]);
    }
  });

  it("suggests valid controls", () => {
    const validControls = new Set(
      DEFAULT_COMPLIANCE_PACKS.flatMap((pack) => pack.controls.map((c) => c.controlRef))
    );
    for (const scenario of SCENARIO_LIBRARY) {
      for (const control of scenario.suggestedControls) {
        expect(validControls.has(control)).toBe(true);
      }
    }
  });
});
