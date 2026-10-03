import { describe, expect, it } from "vitest";
import { DATA_SENSITIVITIES, deriveDataSensitivity } from "./dataSensitivity";

describe("AER-042 data sensitivity from declared data categories", () => {
  it("maps every intake data category to a level the gateway accepts", () => {
    expect(deriveDataSensitivity(["public"])).toBe("public");
    expect(deriveDataSensitivity(["personal"])).toBe("confidential");
    expect(deriveDataSensitivity(["proprietary"])).toBe("confidential");
    for (const c of ["health", "sensitive-personal", "payment-card", "financial"]) {
      expect(deriveDataSensitivity([c])).toBe("regulated");
    }
  });

  it("takes the strictest level across several categories", () => {
    expect(deriveDataSensitivity(["public", "personal"])).toBe("confidential");
    expect(deriveDataSensitivity(["personal", "financial"])).toBe("regulated"); // the credit demo
    expect(deriveDataSensitivity(["public", "proprietary", "public"])).toBe("confidential");
  });

  it("fails closed: no category or an unknown one is regulated", () => {
    expect(deriveDataSensitivity([])).toBe("regulated");
    expect(deriveDataSensitivity(["public", "biometric-templates"])).toBe("regulated");
  });

  it("never produces a value outside the gateway's enum (the old 'restricted' bug)", () => {
    const inputs = [[], ["public"], ["personal"], ["financial"], ["unknown"]];
    for (const input of inputs) expect(DATA_SENSITIVITIES).toContain(deriveDataSensitivity(input));
    expect(DATA_SENSITIVITIES).not.toContain("restricted");
  });
});
