import { describe, expect, it } from "vitest";
import { computeRegulatoryImpact, type RegulatoryUpdate } from "./regulatory-intel.js";

const update = (over: Partial<RegulatoryUpdate> = {}): RegulatoryUpdate => ({
  key: "u",
  jurisdiction: "EU",
  instrument: "Instrument",
  title: "Obligation",
  summary: "s",
  effectiveDate: "2026-12-01",
  status: "upcoming",
  frameworks: ["eu-ai-act", "iso-42001"],
  controlRefs: ["a", "b", "c"],
  sourceUrl: "https://example.org",
  verifiedOn: "2026-10-01",
  ...over,
});
const ctx = {
  activePacks: new Map([["eu-ai-act", 2]]),
  controls: new Map([
    ["a", { title: "A", framework: "eu-ai-act", status: "satisfied" as const }],
    ["b", { title: "B", framework: "eu-ai-act", status: "unsatisfied" as const }],
  ]),
  useCases: [
    { id: "1", name: "Zeta high", status: "approved", euAiActTier: "high" as const },
    { id: "2", name: "Alpha minimal", status: "under_review", euAiActTier: "minimal" as const },
    { id: "3", name: "Retired high", status: "retired", euAiActTier: "high" as const },
    { id: "4", name: "Unscreened", status: "proposed", euAiActTier: null },
  ],
  today: "2026-10-02",
};

describe("ADR-0158 regulatory impact", () => {
  it("joins controls to evidence and counts gaps, including controls in no active pack", () => {
    const [r] = computeRegulatoryImpact([update()], ctx);
    expect(r!.controls.map((c) => c.status)).toEqual(["satisfied", "unsatisfied", "not_in_active_pack"]);
    expect(r!.impact).toMatchObject({ controlsMapped: 3, controlsEvidenced: 1, controlGaps: 2, frameworkGaps: 1 });
    expect(r!.frameworks).toEqual([
      { framework: "eu-ai-act", packActive: true, activeVersion: 2 },
      { framework: "iso-42001", packActive: false, activeVersion: null },
    ]);
    expect(r!.daysUntilEffective).toBe(60);
  });

  it("scope: all live use cases by default, retired and rejected never", () => {
    const [r] = computeRegulatoryImpact([update()], ctx);
    expect(r!.impact.scopeBasis).toBe("all_live_use_cases");
    expect(r!.impact.useCases.map((u) => u.name)).toEqual(["Alpha minimal", "Unscreened", "Zeta high"]);
  });

  it("scope narrows by computed tier, and an unscreened use case is not assumed in scope", () => {
    const [r] = computeRegulatoryImpact([update({ scope: { euAiActTiers: ["high"] } })], ctx);
    expect(r!.impact.scopeBasis).toBe("eu_ai_act_tier");
    expect(r!.impact.useCases.map((u) => u.id)).toEqual(["1"]);
  });

  it("orders by effective date; in-force entries have negative days", () => {
    const out = computeRegulatoryImpact(
      [update({ key: "later", effectiveDate: "2027-08-02" }), update({ key: "past", effectiveDate: "2025-02-02", status: "in_force" })],
      ctx,
    );
    expect(out.map((u) => u.key)).toEqual(["past", "later"]);
    expect(out[0]!.daysUntilEffective).toBeLessThan(0);
  });
});
