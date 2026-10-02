import { describe, it, expect } from "vitest";
import { DEMO_INTAKE_FIXTURES } from "./fixtures.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";
import { classifyEuAiActTier } from "../eu-ai-act.js";
import { intakeAssistRequestSchema } from "../intake-assist.js";

describe("DEMO_INTAKE_FIXTURES", () => {
  const { hero, useCases, risks, vendors, modelCards, shadowAi } = DEMO_INTAKE_FIXTURES;
  const allUseCases = [hero, ...useCases];

  it("has valid intake parsing", () => {
    for (const uc of allUseCases) {
      expect(() => intakeAssistRequestSchema.parse(uc.intake)).not.toThrow();
    }
  });

  it("has expected EU AI Act tiers", () => {
    const tiers = allUseCases.map(uc => classifyEuAiActTier(uc.intake.euAiAct).tier);
    expect(tiers.filter(t => t === "high").length).toBeGreaterThanOrEqual(2);
    expect(tiers.filter(t => t === "prohibited").length).toBe(1);
    expect(tiers.filter(t => t === "limited").length).toBeGreaterThanOrEqual(3);
    
    // hero must be high
    expect(classifyEuAiActTier(hero.intake.euAiAct).tier).toBe("high");
  });

  it("has all valid controlRefs", () => {
    const validRefs = new Set();
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      for (const ctrl of pack.controls) validRefs.add(ctrl.controlRef);
    }
    
    for (const r of risks) {
      for (const ref of r.controls) {
        expect(validRefs.has(ref)).toBe(true);
      }
    }
  });

  it("checks useCaseKeys exist", () => {
    const ucKeys = new Set(allUseCases.map(uc => uc.key));
    for (const r of risks) {
      expect(ucKeys.has(r.useCaseKey)).toBe(true);
    }
  });

  it("checks targetStatus states", () => {
    const ucStatuses = useCases.map(uc => uc.targetStatus);
    expect(ucStatuses.filter(s => s === "proposed").length).toBe(2);
    expect(ucStatuses.filter(s => s === "under_review").length).toBe(2);
    expect(ucStatuses.filter(s => s === "approved").length).toBe(4);
    expect(ucStatuses.filter(s => s === "rejected").length).toBe(1);
    expect(ucStatuses.filter(s => s === "retired").length).toBe(1);
    
    for (const uc of allUseCases) {
      if (uc.targetStatus === "rejected" || uc.targetStatus === "retired") {
        expect(uc.decisionReason).toBeDefined();
      }
    }
  });
  
  it("checks risks state", () => {
    expect(risks.filter(r => r.targetStatus === "accepted").length).toBe(2);
    for (const r of risks.filter(r => r.targetStatus === "accepted")) {
      expect(r.acceptanceNote).toBeDefined();
    }
    
    expect(risks.filter(r => r.targetStatus === "closed").length).toBe(4);
    for (const r of risks.filter(r => r.targetStatus === "closed")) {
      expect(r.closeReason).toBeDefined();
    }
  });
});
