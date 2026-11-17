import { describe, expect, it } from "vitest";
import {
  AGENT_RISKS,
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

  it("looks proofs up by their stable key", () => {
    expect(agentRiskProofByKey("access_control.approval_replay")?.risk.key).toBe("access_control_failure");
    expect(agentRiskProofByKey("nope")).toBeUndefined();
  });
});
