import { describe, expect, it } from "vitest";
import { computeRegulatoryImpact, regulatoryUpdateProblems, type RegulatoryUpdate } from "./regulatory-intel.js";

const update = (over: Partial<RegulatoryUpdate> = {}): RegulatoryUpdate => ({
  key: "u",
  jurisdiction: "EU",
  instrument: "Instrument",
  title: "Obligation",
  summary: "s",
  effectiveDate: "2026-12-01",
  status: "upcoming",
  instrumentKind: "law",
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

  it("passes the instrument kind, enforcement and withdrawal dates through, with days to enforcement", () => {
    const [law] = computeRegulatoryImpact([update({ instrumentKind: "law", status: "in_force", effectiveDate: "2026-09-01", enforcementDate: "2026-12-01" })], ctx);
    expect(law).toMatchObject({ instrumentKind: "law", enforcementDate: "2026-12-01", withdrawnOn: null, daysUntilEnforcement: 60 });
    const [gone] = computeRegulatoryImpact([update({ instrumentKind: "guidance", status: "withdrawn", effectiveDate: "2022-05-26", withdrawnOn: "2025-05-12" })], ctx);
    expect(gone).toMatchObject({ status: "withdrawn", withdrawnOn: "2025-05-12", enforcementDate: null, daysUntilEnforcement: null });
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

// ADR-0179 G14-FEED: the feed consistency rules, each with its own red case.
describe("ADR-0179 regulatory feed consistency rules", () => {
  const problems = (over: Partial<RegulatoryUpdate>) => regulatoryUpdateProblems(update(over));

  it("a consistent law, guidance and voluntary standard pass", () => {
    expect(problems({})).toEqual([]);
    expect(problems({ instrumentKind: "guidance", status: "in_force", effectiveDate: "2022-05-26" })).toEqual([]);
    expect(problems({ instrumentKind: "voluntary_standard", status: "published", effectiveDate: "2023-01-26" })).toEqual([]);
  });

  it("R1: a voluntary standard is never in force", () => {
    expect(problems({ instrumentKind: "voluntary_standard", status: "in_force" }).join()).toMatch(/voluntary standard is never in force/);
  });

  it("R2: only a voluntary standard is 'published'", () => {
    expect(problems({ instrumentKind: "law", status: "published" }).join()).toMatch(/only a voluntary standard is 'published'/);
  });

  it("R3: a withdrawn entry carries its withdrawal date, and only a withdrawn entry does", () => {
    expect(problems({ instrumentKind: "guidance", status: "withdrawn" }).join()).toMatch(/needs a withdrawnOn date/);
    expect(problems({ status: "in_force", effectiveDate: "2022-01-01", withdrawnOn: "2025-05-12" }).join()).toMatch(/withdrawnOn is set/);
    expect(problems({ instrumentKind: "guidance", status: "withdrawn", effectiveDate: "2025-06-01", withdrawnOn: "2025-05-12" }).join()).toMatch(/before effectiveDate/);
  });

  it("R4: an enforcement date is a separate, later date, and only on a law", () => {
    expect(problems({ effectiveDate: "2023-07-05", enforcementDate: "2023-01-01" }).join()).toMatch(/must be after effectiveDate/);
    expect(problems({ effectiveDate: "2023-01-01", enforcementDate: "2023-01-01" }).join()).toMatch(/must be after effectiveDate/);
    expect(problems({ instrumentKind: "guidance", effectiveDate: "2023-01-01", enforcementDate: "2023-07-05" }).join()).toMatch(/only a law has an enforcement date/);
    expect(problems({ effectiveDate: "2023-01-01", enforcementDate: "2023-07-05" })).toEqual([]);
  });

  it("R5: the join fails closed on an inconsistent entry instead of presenting it", () => {
    expect(() => computeRegulatoryImpact([update({ instrumentKind: "voluntary_standard", status: "in_force" })], ctx)).toThrow(/inconsistent/);
  });
});
