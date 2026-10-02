import { describe, it, expect } from "vitest";
import { DEMO_INTAKE_FIXTURES } from "./fixtures.js";
import { DEFAULT_COMPLIANCE_PACKS } from "../compliance-packs.js";
import { classifyEuAiActTier } from "../eu-ai-act.js";
import { intakeAssistRequestSchema } from "../intake-assist.js";

describe("DEMO_INTAKE_FIXTURES", () => {
  const { hero, useCases, risks, vendors, modelCards, shadowAi } = DEMO_INTAKE_FIXTURES;
  const allUseCases = [hero, ...useCases];

  // ---------------------------------------------------------------------------
  // Intake parsing
  // ---------------------------------------------------------------------------

  it("has valid intake parsing for all use cases", () => {
    for (const uc of allUseCases) {
      expect(() => intakeAssistRequestSchema.parse(uc.intake)).not.toThrow();
    }
  });

  // ---------------------------------------------------------------------------
  // EU AI Act tier spread
  // ---------------------------------------------------------------------------

  it("hero is classified as EU AI Act high risk", () => {
    expect(classifyEuAiActTier(hero.intake.euAiAct).tier).toBe("high");
  });

  it("has at least 2 high-risk use cases (including hero)", () => {
    const tiers = allUseCases.map((uc) => classifyEuAiActTier(uc.intake.euAiAct).tier);
    expect(tiers.filter((t) => t === "high").length).toBeGreaterThanOrEqual(2);
  });

  it("has exactly 1 prohibited use case", () => {
    const tiers = useCases.map((uc) => classifyEuAiActTier(uc.intake.euAiAct).tier);
    expect(tiers.filter((t) => t === "prohibited").length).toBe(1);
  });

  it("has at least 3 limited-risk use cases", () => {
    const tiers = allUseCases.map((uc) => classifyEuAiActTier(uc.intake.euAiAct).tier);
    expect(tiers.filter((t) => t === "limited").length).toBeGreaterThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Use case targetStatus spread (across the 10 non-hero use cases)
  // ---------------------------------------------------------------------------

  it("has correct targetStatus spread across the 10 use cases", () => {
    const statuses = useCases.map((uc) => uc.targetStatus);
    expect(statuses.filter((s) => s === "proposed").length).toBe(2);
    expect(statuses.filter((s) => s === "under_review").length).toBe(2);
    expect(statuses.filter((s) => s === "approved").length).toBe(4);
    expect(statuses.filter((s) => s === "rejected").length).toBe(1);
    expect(statuses.filter((s) => s === "retired").length).toBe(1);
  });

  it("rejected and retired use cases have a decisionReason", () => {
    for (const uc of allUseCases) {
      if (uc.targetStatus === "rejected" || uc.targetStatus === "retired") {
        expect(uc.decisionReason).toBeDefined();
        expect((uc.decisionReason as string).length).toBeGreaterThan(0);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Risk controlRefs — every ref must exist in DEFAULT_COMPLIANCE_PACKS
  // ---------------------------------------------------------------------------

  it("has all valid controlRefs in DEFAULT_COMPLIANCE_PACKS", () => {
    const validRefs = new Set<string>();
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      for (const ctrl of pack.controls) validRefs.add(ctrl.controlRef);
    }
    for (const r of risks) {
      for (const ref of r.controls) {
        expect(validRefs.has(ref), `controlRef '${ref}' on risk '${r.key}' is not in DEFAULT_COMPLIANCE_PACKS`).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Cross-key integrity — useCaseKey and vendorKey must resolve
  // ---------------------------------------------------------------------------

  it("risk useCaseKey values resolve to known use-case keys", () => {
    const ucKeys = new Set(allUseCases.map((uc) => uc.key));
    for (const r of risks) {
      if (r.useCaseKey !== undefined) {
        expect(ucKeys.has(r.useCaseKey), `risk '${r.key}' useCaseKey '${r.useCaseKey}' not found`).toBe(true);
      }
    }
  });

  it("risk vendorKey values resolve to known vendor keys", () => {
    const vendorKeys = new Set(vendors.map((v) => v.key));
    for (const r of risks) {
      if (r.vendorKey !== undefined) {
        expect(vendorKeys.has(r.vendorKey), `risk '${r.key}' vendorKey '${r.vendorKey}' not found`).toBe(true);
      }
    }
  });

  it("every risk has at least one of useCaseKey or vendorKey", () => {
    for (const r of risks) {
      expect(
        r.useCaseKey !== undefined || r.vendorKey !== undefined,
        `risk '${r.key}' has neither useCaseKey nor vendorKey`
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Risk count and status spread
  // ---------------------------------------------------------------------------

  it("has between 25 and 35 risks", () => {
    expect(risks.length).toBeGreaterThanOrEqual(25);
    expect(risks.length).toBeLessThanOrEqual(35);
  });

  it("has at least ~60% mitigating risks (with residual)", () => {
    const mitigating = risks.filter((r) => r.targetStatus === "mitigating");
    expect(mitigating.length / risks.length).toBeGreaterThanOrEqual(0.4);
    // Every mitigating risk should have a residual position
    for (const r of mitigating) {
      expect(r.residual, `mitigating risk '${r.key}' is missing residual`).toBeDefined();
    }
  });

  it("has exactly 2 accepted risks with acceptanceNote", () => {
    const accepted = risks.filter((r) => r.targetStatus === "accepted");
    expect(accepted.length).toBe(2);
    for (const r of accepted) {
      expect(r.acceptanceNote, `accepted risk '${r.key}' is missing acceptanceNote`).toBeDefined();
      expect((r.acceptanceNote as string).length).toBeGreaterThan(0);
    }
  });

  it("has exactly 4 closed risks with closeReason", () => {
    const closed = risks.filter((r) => r.targetStatus === "closed");
    expect(closed.length).toBe(4);
    for (const r of closed) {
      expect(r.closeReason, `closed risk '${r.key}' is missing closeReason`).toBeDefined();
      expect((r.closeReason as string).length).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // G5 — vendor-scoped risk for dependency-graph beat
  // ---------------------------------------------------------------------------

  it("has at least one vendor-only (vendorKey only) risk at high × high", () => {
    const vendorOnlyHighHigh = risks.filter(
      (r) => r.vendorKey !== undefined && r.useCaseKey === undefined &&
             r.likelihood === "high" && r.impact === "high"
    );
    expect(vendorOnlyHighHigh.length).toBeGreaterThanOrEqual(1);
  });

  it("the vendor-only high risk targets vendor-mock (the hero agent's provider)", () => {
    const vendorOnlyHighHigh = risks.filter(
      (r) => r.vendorKey !== undefined && r.useCaseKey === undefined &&
             r.likelihood === "high" && r.impact === "high"
    );
    const vendorKeys = vendorOnlyHighHigh.map((r) => r.vendorKey);
    expect(vendorKeys).toContain("vendor-mock");
  });

  // ---------------------------------------------------------------------------
  // Model cards
  // ---------------------------------------------------------------------------

  it("has model cards for all unique intendedAgentNames", () => {
    const agentNamesWithCards = new Set(modelCards.map((mc) => mc.agentName));
    const allIntendedAgentNames = new Set(allUseCases.flatMap((uc) => uc.intendedAgentNames));
    for (const agentName of allIntendedAgentNames) {
      expect(agentNamesWithCards.has(agentName), `no model card for agent '${agentName}'`).toBe(true);
    }
  });

  it("has at least 2 model cards with an assessed biasFairness entry", () => {
    const withAssessed = modelCards.filter((mc) =>
      mc.biasFairness.some((bf) => bf.status === "assessed")
    );
    expect(withAssessed.length).toBeGreaterThanOrEqual(2);
  });

  it("has exactly 1 model card with an in_progress biasFairness entry", () => {
    const withInProgress = modelCards.filter((mc) =>
      mc.biasFairness.some((bf) => bf.status === "in_progress")
    );
    expect(withInProgress.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Shadow AI
  // ---------------------------------------------------------------------------

  it("has exactly 6 shadow AI findings", () => {
    expect(shadowAi.length).toBe(6);
  });

  it("shadow AI findings have synthetic grantedBy addresses", () => {
    for (const s of shadowAi) {
      expect(s.grantedBy).toMatch(/^user-\d+@acme\.example$/);
    }
  });

  // ---------------------------------------------------------------------------
  // Vendors
  // ---------------------------------------------------------------------------

  it("has exactly 5 vendors", () => {
    expect(vendors.length).toBe(5);
  });

  it("vendor-mock links to hero agent provider (mock)", () => {
    const vendorMock = vendors.find((v) => v.key === "vendor-mock");
    expect(vendorMock).toBeDefined();
    expect(vendorMock!.linkedAgentProviders).toContain("mock");
  });
});
