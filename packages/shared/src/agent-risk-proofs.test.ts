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
