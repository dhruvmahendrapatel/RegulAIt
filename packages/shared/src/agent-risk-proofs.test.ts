import { describe, expect, it } from "vitest";
import { MEASUREMENT_STATES } from "./assurance.js";
import {
  AGENT_RISKS,
  AGENT_RISK_PROOF_OUTCOMES,
  agentRiskControlColumns,
  AGENT_RISK_KEYS,
  agentRiskCatalogProblems,
  agentRiskProofByKey,
  agentRiskProofs,
  effectiveRiskTier,
  JURISDICTION_CODE_RE,
  resolveGeography,
  type AgentRisk,
} from "./agent-risk-proofs.js";

describe("ADR-0345 agent risk / control / proof catalogue", () => {
  it("is sound: every risk has a control and a proof, and every reference resolves", () => {
    expect(agentRiskCatalogProblems()).toEqual([]);
  });

  it("covers the ten agent risks the owner named", () => {
    expect(AGENT_RISKS.map((r) => r.key).sort()).toEqual([...AGENT_RISK_KEYS].sort());
  });

  it("names the owner's example proofs", () => {
    for (const probe of ["hidden_instruction_in_document", "approval_replay", "tool_out_of_scope_argument", "loop_turn_cap"]) {
      expect(agentRiskProofs().some((p) => p.proof.probe === probe)).toBe(true);
    }
  });

  it("refuses a heading with no test, an unknown pack control and a proof without its input", () => {
    const base = AGENT_RISKS[0]!;
    const broken: AgentRisk[] = [
      { ...base, proofs: [] },
      ...AGENT_RISKS.slice(1),
    ];
    expect(agentRiskCatalogProblems(broken)).toContain(`${base.key}: no proof (a risk with no test is just a heading)`);
    const badRef: AgentRisk[] = [{ ...base, owaspRefs: ["owasp-llm-top-10:nope"] }, ...AGENT_RISKS.slice(1)];
    expect(agentRiskCatalogProblems(badRef)).toContain(`${base.key}: unknown pack control owasp-llm-top-10:nope`);
    const { probe: _dropped, ...withoutProbe } = base.proofs[0]!;
    const noInput: AgentRisk[] = [
      { ...base, proofs: [{ ...withoutProbe, engine: "gateway_probe" }] },
      ...AGENT_RISKS.slice(1),
    ];
    expect(agentRiskCatalogProblems(noInput).some((p) => p.includes("missing or names an unknown input"))).toBe(true);
  });

  it("reuses the ADR-0180 assurance contract: one outcome vocabulary, metric proofs as MetricSpecs", () => {
    expect(AGENT_RISK_PROOF_OUTCOMES).toBe(MEASUREMENT_STATES);
    const metrics = agentRiskProofs().filter((p) => p.proof.engine === "assurance_metric");
    expect(metrics.map((p) => p.proof.metric!.metric)).toEqual(expect.arrayContaining(["redteam_asr", "guardrail_mode", "eval_pass_rate"]));
    const bad: AgentRisk[] = [
      { ...AGENT_RISKS[0]!, proofs: [{ ...metrics[0]!.proof, metric: { ...metrics[0]!.proof.metric!, params: { attackClass: "nope" } } }] },
      ...AGENT_RISKS.slice(1),
    ];
    expect(agentRiskCatalogProblems(bad).some((p) => p.includes("missing or names an unknown input"))).toBe(true);
  });

  it("binds every control to a real setting shape, a policy table or a named behaviour with its ADR", () => {
    expect(agentRiskControlColumns()).toContain("org_settings.mcp_admission_mode");
    const bad: AgentRisk[] = [
      { ...AGENT_RISKS[0]!, controls: [{ kind: "setting", column: "mcp_admission.mode.x", secure: { oneOf: ["enforce"] }, adr: "ADR-0097" }] },
      ...AGENT_RISKS.slice(1),
    ];
    expect(agentRiskCatalogProblems(bad)).toContain("prompt_injection: control column mcp_admission.mode.x is not table.column");
  });

  it("looks proofs up by their stable key", () => {
    expect(agentRiskProofByKey("access_control.approval_replay")?.risk.key).toBe("access_control_failure");
    expect(agentRiskProofByKey("nope")).toBeUndefined();
  });
});

describe("ADR-0345 §9 geography", () => {
  const J = [
    { code: "EU", parentCode: null, global: false },
    { code: "US", parentCode: null, global: false },
    { code: "US-CO", parentCode: "US", global: false },
    { code: "International", parentCode: null, global: true },
  ];
  const O = [
    { jurisdictionCode: "EU", regulatoryUpdateKey: "eu-x", agentRiskKey: "prompt_injection" as const, tierFloor: null },
    { jurisdictionCode: "US", regulatoryUpdateKey: "us-x", agentRiskKey: "governance_gap" as const, tierFloor: "limited" as const },
    { jurisdictionCode: "US-CO", regulatoryUpdateKey: "co-x", agentRiskKey: "hallucination" as const, tierFloor: "high" as const },
    { jurisdictionCode: "International", regulatoryUpdateKey: "iso", agentRiskKey: "governance_gap" as const, tierFloor: null },
  ];

  it("brings in the declared jurisdiction, its ancestors and the global ones", () => {
    const r = resolveGeography(["US-CO"], J, O);
    expect(r.inScope).toEqual(["International", "US", "US-CO"]);
    expect(r.obligations.map((o) => o.regulatoryUpdateKey).sort()).toEqual(["co-x", "iso", "us-x"]);
    expect(r.tierFloor).toBe("high");
    expect(r.undeclared).toBe(false);
  });

  it("strict default: a use case that declares none is in scope of every jurisdiction", () => {
    const r = resolveGeography([], J, O);
    expect(r.undeclared).toBe(true);
    expect(r.obligations).toHaveLength(4);
  });

  it("reports an unknown code rather than dropping it, and survives a parent cycle", () => {
    const cyclic = [
      { code: "AA", parentCode: "BB", global: false },
      { code: "BB", parentCode: "AA", global: false },
    ];
    const r = resolveGeography(["AA", "ZZ"], cyclic, []);
    expect(r.unknown).toEqual(["ZZ"]);
    expect(r.inScope).toEqual(["AA", "BB"]);
  });

  it("raises the screened tier to the floor, never lowers it, and never stands in for screening", () => {
    expect(effectiveRiskTier("minimal", "high")).toBe("high");
    expect(effectiveRiskTier("prohibited", "high")).toBe("prohibited");
    expect(effectiveRiskTier("limited", null)).toBe("limited");
    expect(effectiveRiskTier("unscreened", "high")).toBe("unscreened");
  });

  it("the code shape the feed uses", () => {
    for (const c of ["EU", "US", "US-CO", "US-NYC", "International"]) expect(JURISDICTION_CODE_RE.test(c)).toBe(true);
    expect(JURISDICTION_CODE_RE.test("eu")).toBe(false);
  });
});
