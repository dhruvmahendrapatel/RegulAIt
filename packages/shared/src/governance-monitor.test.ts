import { describe, expect, it } from "vitest";
import {
  MONITOR_RULE_IDS,
  evaluateMonitorRules,
  reconcileAlerts,
  type MonitorAgentInput,
  type MonitorInput,
} from "./governance-monitor.js";
import type { PropagatedRating } from "./dependency-graph.js";

const none: PropagatedRating = { score: 0, band: "none", sourceNodeKey: null, sourceRiskId: null, path: [] };
const agent = (id: string, over: Partial<MonitorAgentInput> = {}): MonitorAgentInput => ({
  id, name: `Agent ${id}`, halted: false, enabled: true, lifecycleStatus: "active", ownership: "owned", modelCardApproved: true, ...over,
});
const base = (over: Partial<MonitorInput> = {}): MonitorInput => ({
  useCases: [], agents: new Map(), vendors: new Map(), risks: [], dimensions: [], ...over,
});

describe("ADR-0157 monitor rules", () => {
  it("a clean approved use case raises nothing", () => {
    const f = evaluateMonitorRules(base({
      useCases: [{ id: "u", name: "UC", status: "approved", propagated: none, agentIds: ["a"], vendorIds: ["v"] }],
      agents: new Map([["a", agent("a")]]),
      vendors: new Map([["v", { id: "v", name: "V", status: "approved" }]]),
    }));
    expect(f).toEqual([]);
  });

  it("inherited high rating names the source and readable path", () => {
    const propagated: PropagatedRating = {
      score: 9, band: "high", sourceNodeKey: "vendor:v", sourceRiskId: "r", path: ["use_case:u", "agent:a", "vendor:v"],
    };
    const [f] = evaluateMonitorRules(base({
      useCases: [{ id: "u", name: "UC", status: "approved", propagated, agentIds: [], vendorIds: [] }],
      labels: new Map([["vendor:v", "Acme"], ["agent:a", "Bot"], ["use_case:u", "UC"]]),
    }));
    expect(f).toMatchObject({ ruleId: "use_case_inherited_high_risk", subjectKey: "use_case:u", severity: "high" });
    expect(f!.title).toBe("UC inherits a HIGH rating from Acme");
    expect(f!.detail.pathLabels).toEqual(["UC", "Bot", "Acme"]);
  });

  it("use-case rules fire only for APPROVED use cases", () => {
    const f = evaluateMonitorRules(base({
      useCases: [{ id: "u", name: "UC", status: "under_review", propagated: { ...none, band: "high", score: 9, sourceNodeKey: "use_case:u" }, agentIds: ["a"], vendorIds: ["v"] }],
      agents: new Map([["a", agent("a", { halted: true, ownership: "unowned", modelCardApproved: false })]]),
      vendors: new Map([["v", { id: "v", name: "V", status: "rejected" }]]),
    }));
    expect(f).toEqual([]);
  });

  it("agent and vendor conditions are keyed by the (use case, dependency) pair", () => {
    const f = evaluateMonitorRules(base({
      useCases: [
        { id: "u1", name: "One", status: "approved", propagated: none, agentIds: ["a"], vendorIds: ["v"] },
        { id: "u2", name: "Two", status: "approved", propagated: none, agentIds: ["a"], vendorIds: [] },
      ],
      agents: new Map([["a", agent("a", { lifecycleStatus: "retired", ownership: "orphaned", modelCardApproved: false })]]),
      vendors: new Map([["v", { id: "v", name: "V", status: "under_assessment" }]]),
    }));
    const ids = f.map((x) => `${x.ruleId}|${x.subjectKey}`);
    expect(ids).toEqual([
      "use_case_agent_halted|use_case:u1>agent:a",
      "use_case_agent_halted|use_case:u2>agent:a",
      "use_case_agent_no_approved_model_card|use_case:u1>agent:a",
      "use_case_agent_no_approved_model_card|use_case:u2>agent:a",
      "use_case_agent_unowned|use_case:u1>agent:a",
      "use_case_agent_unowned|use_case:u2>agent:a",
      "use_case_vendor_unapproved|use_case:u1>vendor:v",
    ]);
    expect(f.find((x) => x.ruleId === "use_case_vendor_unapproved")!.title).toContain("under assessment");
  });

  it("high risk without control: live and high only, decided risks excluded", () => {
    const f = evaluateMonitorRules(base({
      risks: [
        { id: "1", title: "live high bare", status: "open", band: "high", controls: 0 },
        { id: "2", title: "live high linked", status: "mitigating", band: "high", controls: 1 },
        { id: "3", title: "accepted", status: "accepted", band: "high", controls: 0 },
        { id: "4", title: "medium", status: "open", band: "medium", controls: 0 },
      ],
    }));
    expect(f.map((x) => x.subjectKey)).toEqual(["risk:1"]);
  });

  it("coverage floor fires on measured dimensions only", () => {
    const f = evaluateMonitorRules(base({
      coverageFloorPct: 60,
      dimensions: [
        { key: "bias", label: "Bias", measured: false, evidenceCoveragePct: null, controlsEvidenced: 0, controlsApplicable: 0 },
        { key: "security", label: "Security", measured: true, evidenceCoveragePct: 59, controlsEvidenced: 59, controlsApplicable: 100 },
        { key: "privacy", label: "Privacy", measured: true, evidenceCoveragePct: 60, controlsEvidenced: 6, controlsApplicable: 10 },
      ],
    }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ subjectKey: "dimension:security", title: "Security evidence coverage is 59% (floor 60%)" });
  });
});

describe("ADR-0160 output leakage rule", () => {
  it("fires per (use case, agent) only when flagged > 0, and only for approved use cases", () => {
    const leaky = agent("a", { outputLeaks: { flagged: 2, evaluated: 40, byDetector: { pii: 2 } } });
    const f = evaluateMonitorRules(base({
      useCases: [
        { id: "u", name: "UC", status: "approved", propagated: none, agentIds: ["a"], vendorIds: [] },
        { id: "p", name: "Proposal", status: "proposed", propagated: none, agentIds: ["a"], vendorIds: [] },
      ],
      agents: new Map([["a", leaky]]),
    }));
    expect(f).toEqual([
      expect.objectContaining({ ruleId: "agent_output_leakage", subjectKey: "use_case:u>agent:a", severity: "high" }),
    ]);
    expect(f[0]!.title).toContain("2 of 40");
    const clean = evaluateMonitorRules(base({
      useCases: [{ id: "u", name: "UC", status: "approved", propagated: none, agentIds: ["a"], vendorIds: [] }],
      agents: new Map([["a", agent("a", { outputLeaks: { flagged: 0, evaluated: 40, byDetector: {} } })]]),
    }));
    expect(clean).toEqual([]);
  });
});

describe("ADR-0164 served outside the approved stack", () => {
  const off = (calls: number) => ({
    servedAgentId: "b",
    servedAgentName: "fast-mock",
    requested: [{ agentId: "a", name: "approved-agent", calls }],
    calls,
    lastServedAt: "2026-10-02T00:00:00.000Z",
    windowDays: 7,
  });
  it("fires per (approved use case, serving agent), names the requested agents, and only for approved use cases", () => {
    const f = evaluateMonitorRules(base({
      useCases: [
        { id: "u", name: "UC", status: "approved", propagated: none, agentIds: ["a"], vendorIds: [], servedOutsideStack: [off(3)] },
        { id: "p", name: "Proposal", status: "proposed", propagated: none, agentIds: ["a"], vendorIds: [], servedOutsideStack: [off(9)] },
      ],
      agents: new Map([["a", agent("a")]]),
    }));
    expect(f).toEqual([
      expect.objectContaining({ ruleId: "use_case_served_outside_stack", subjectKey: "use_case:u>agent:b", severity: "high" }),
    ]);
    expect(f[0]!.title).toBe("3 calls for UC (to approved-agent) were served by fast-mock, which is outside its approved stack");
    expect(f[0]!.detail).toMatchObject({ useCaseId: "u", servedAgentId: "b", calls: 3, windowDays: 7 });
  });
  it("is silent with no off-stack dispatches (empty, absent, or zero calls)", () => {
    for (const servedOutsideStack of [[], undefined, [off(0)]]) {
      expect(
        evaluateMonitorRules(base({
          useCases: [{
            id: "u", name: "UC", status: "approved", propagated: none, agentIds: ["a"], vendorIds: [],
            ...(servedOutsideStack ? { servedOutsideStack } : {}),
          }],
          agents: new Map([["a", agent("a")]]),
        })),
      ).toEqual([]);
    }
  });
});

describe("ADR-0157 reconciliation", () => {
  const finding = (subjectKey: string) => ({
    ruleId: "high_risk_without_control" as const, subjectKey, severity: "high" as const, title: "t", detail: {},
  });

  it("raises new, refreshes persisting, resolves cleared", () => {
    const r = reconcileAlerts(
      [
        { id: "A", ruleId: "high_risk_without_control", subjectKey: "risk:1" },
        { id: "B", ruleId: "high_risk_without_control", subjectKey: "risk:2" },
      ],
      [finding("risk:1"), finding("risk:3")],
    );
    expect(r.raise.map((f) => f.subjectKey)).toEqual(["risk:3"]);
    expect(r.refresh.map((x) => x.id)).toEqual(["A"]);
    expect(r.resolve).toEqual(["B"]);
  });

  it("never resolves an alert from a rule this pass did not evaluate", () => {
    const r = reconcileAlerts(
      [{ id: "X", ruleId: "dimension_coverage_below_floor", subjectKey: "dimension:bias" }],
      [],
      new Set(MONITOR_RULE_IDS.filter((id) => id !== "dimension_coverage_below_floor")),
    );
    expect(r.resolve).toEqual([]);
  });
});
