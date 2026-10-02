import { describe, expect, it } from "vitest";
import { proposeRemediations, type RemediationContext } from "./remediation.js";

const active = new Map([
  ["soc-2:CC7.2-monitoring", "Monitoring"],
  ["eu-ai-act:art-15-accuracy-robustness", "Accuracy & robustness"],
]);
const risk = (over = {}) => ({ id: "r1", title: "Injection", category: "prompt_injection" as const, linkedControls: [] as string[], ...over });
const ctx = (over: Partial<RemediationContext> = {}): RemediationContext => ({
  alert: { ruleId: "high_risk_without_control", subjectKey: "risk:r1", detail: {} },
  risks: new Map([["r1", risk()]]),
  activeControls: active,
  ...over,
});

describe("ADR-0159 remediation planner", () => {
  it("proposes executable control links from the category's suggestions that are in an active pack", () => {
    const out = proposeRemediations(ctx());
    expect(out.map((c) => [c.kind, c.executable, c.params.controlRef])).toEqual([
      ["link_control", true, "soc-2:CC7.2-monitoring"],
      ["link_control", true, "eu-ai-act:art-15-accuracy-robustness"],
    ]);
  });

  it("skips controls already linked, and falls back to guidance when none remain", () => {
    const linkedOne = proposeRemediations(ctx({ risks: new Map([["r1", risk({ linkedControls: ["soc-2:CC7.2-monitoring"] })]]) }));
    expect(linkedOne.map((c) => c.params.controlRef)).toEqual(["eu-ai-act:art-15-accuracy-robustness"]);
    const none = proposeRemediations(ctx({ activeControls: new Map() }));
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ kind: "author_control", executable: false });
  });

  it("inherited high risk: links on the SOURCE risk plus a re-assessment step", () => {
    const out = proposeRemediations(
      ctx({ alert: { ruleId: "use_case_inherited_high_risk", subjectKey: "use_case:u", detail: { sourceRiskId: "r1", sourceNodeKey: "vendor:v" } } }),
    );
    expect(out.filter((c) => c.executable).every((c) => c.params.riskId === "r1")).toBe(true);
    expect(out[out.length - 1]).toMatchObject({ kind: "mitigate_source_risk", executable: false });
  });

  it("unowned agent: executable only when an active use-case owner exists", () => {
    const alert = { ruleId: "use_case_agent_unowned", subjectKey: "use_case:u>agent:a", detail: {} };
    const withOwner = proposeRemediations(ctx({ alert, useCaseOwner: { id: "o", name: "Dana" } }));
    expect(withOwner).toEqual([expect.objectContaining({ kind: "assign_agent_owner", executable: true, params: { agentId: "a", ownerUserId: "o" } })]);
    const without = proposeRemediations(ctx({ alert, useCaseOwner: null }));
    expect(without[0]).toMatchObject({ kind: "assign_agent_owner", executable: false });
  });

  it("guidance-only rules never produce an executable candidate", () => {
    for (const ruleId of ["use_case_agent_halted", "use_case_vendor_unapproved", "use_case_agent_no_approved_model_card", "dimension_coverage_below_floor"]) {
      const out = proposeRemediations(ctx({ alert: { ruleId, subjectKey: "use_case:u>agent:a", detail: { dimension: "safety" } } }));
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((c) => !c.executable && c.steps.length > 0)).toBe(true);
    }
  });
});
