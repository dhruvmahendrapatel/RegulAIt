import { describe, expect, it } from "vitest";
import { evaluateDeployGate, type DeployGateAgentInput, type DeployGateInput } from "./deploy-gate.js";

const agent = (id: string, over: Partial<DeployGateAgentInput> = {}): DeployGateAgentInput => ({
  id, name: `Agent ${id}`, halted: false, enabled: true, lifecycleStatus: "active", mrmRefusal: null, modelCardApproved: true, ...over,
});
const input = (over: Partial<DeployGateInput> = {}): DeployGateInput => ({
  useCase: { id: "u", name: "UC", status: "approved", intendedAgentIds: ["a"] },
  requestedAgentIds: null,
  agents: new Map([["a", agent("a")]]),
  alerts: [],
  ...over,
});

describe("ADR-0161 deploy gate", () => {
  it("allows a clean approved use case (negative control)", () => {
    expect(evaluateDeployGate(input())).toEqual({ decision: "allow", reasons: [], agentsChecked: ["a"] });
  });

  it("blocks an unapproved use case and an agent outside the approved stack", () => {
    const r = evaluateDeployGate(input({
      useCase: { id: "u", name: "UC", status: "under_review", intendedAgentIds: ["a"] },
      requestedAgentIds: ["a", "x"],
      agents: new Map([["a", agent("a")], ["x", agent("x")]]),
    }));
    expect(r.decision).toBe("deny");
    expect(r.reasons.map((x) => x.code).sort()).toEqual(["agent_not_in_approved_stack", "use_case_not_approved"]);
  });

  it("blocks halted agents and MRM refusals; warns on an unapproved card when MRM is off", () => {
    const halted = evaluateDeployGate(input({ agents: new Map([["a", agent("a", { halted: true })]]) }));
    expect(halted.reasons[0]).toMatchObject({ code: "agent_unavailable", severity: "block" });
    const mrm = evaluateDeployGate(input({ agents: new Map([["a", agent("a", { mrmRefusal: "no approved card", modelCardApproved: false })]]) }));
    expect(mrm.reasons.map((x) => x.code)).toEqual(["mrm_refused"]);
    const warnOnly = evaluateDeployGate(input({ agents: new Map([["a", agent("a", { modelCardApproved: false })]]) }));
    expect(warnOnly).toMatchObject({ decision: "allow", reasons: [{ code: "model_card_unapproved", severity: "warn" }] });
  });

  it("ADR-0168: an approval past its valid-until blocks as approval_expired; a future one does not", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const expired = evaluateDeployGate(input({
      useCase: { id: "u", name: "UC", status: "approved", intendedAgentIds: ["a"], approvedUntil: "2026-10-01T00:00:00Z" },
      now,
    }));
    expect(expired).toMatchObject({
      decision: "deny",
      reasons: [{ code: "approval_expired", severity: "block", message: '"UC" approval expired on 2026-10-01; re-review required' }],
    });
    const live = evaluateDeployGate(input({
      useCase: { id: "u", name: "UC", status: "approved", intendedAgentIds: ["a"], approvedUntil: "2027-04-01T00:00:00Z" },
      now,
    }));
    expect(live.decision).toBe("allow");
    // only an APPROVED use case can be expired — any other status is refused by its own name
    const notApproved = evaluateDeployGate(input({
      useCase: { id: "u", name: "UC", status: "under_review", intendedAgentIds: ["a"], approvedUntil: "2026-10-01T00:00:00Z" },
      now,
    }));
    expect(notApproved.reasons.map((x) => x.code)).toEqual(["use_case_not_approved"]);
  });

  it("ADR-0168: open before-go-live conditions block, named with their text", () => {
    const r = evaluateDeployGate(input({
      openBlockingConditions: [{ id: "c1", text: "DPIA signed" }, { id: "c2", text: "bias eval passed" }],
    }));
    expect(r).toMatchObject({
      decision: "deny",
      reasons: [{
        code: "open_blocking_condition",
        severity: "block",
        message: '"UC" has 2 open before-go-live condition(s): DPIA signed; bias eval passed',
        ref: { type: "use_case", id: "u" },
      }],
    });
    expect(evaluateDeployGate(input({ openBlockingConditions: [] })).decision).toBe("allow");
  });

  it("an open high alert blocks; acknowledged high and open medium only warn", () => {
    const alerts = [
      { id: "1", ruleId: "r", severity: "high", status: "open", title: "open high" },
      { id: "2", ruleId: "r", severity: "high", status: "acknowledged", title: "ack high" },
      { id: "3", ruleId: "r", severity: "medium", status: "open", title: "medium" },
    ];
    const r = evaluateDeployGate(input({ alerts }));
    expect(r.decision).toBe("deny");
    expect(r.reasons.map((x) => [x.code, x.severity])).toEqual([
      ["open_high_alert", "block"],
      ["acknowledged_high_alert", "warn"],
      ["open_medium_alert", "warn"],
    ]);
    expect(evaluateDeployGate(input({ alerts: alerts.slice(1) })).decision).toBe("allow");
  });
});

describe("AER-044 — a selection never narrows the checked stack", () => {
  // intended stack: a clean agent "a" and a second intended agent "b"
  const stack = (b: DeployGateAgentInput): Partial<DeployGateInput> => ({
    useCase: { id: "u", name: "UC", status: "approved", intendedAgentIds: ["a", "b"] },
    agents: new Map([["a", agent("a")], ["b", b]]),
  });
  const selections: Array<[string, string[] | null]> = [["omitted", null], ["empty", []], ["subset excluding b", ["a"]]];

  for (const [label, requestedAgentIds] of selections) {
    it(`${label}: a halted intended agent still blocks`, () => {
      const r = evaluateDeployGate(input({ ...stack(agent("b", { halted: true })), requestedAgentIds }));
      expect(r.decision).toBe("deny");
      expect(r.agentsChecked).toEqual(["a", "b"]);
      expect(r.reasons).toEqual([expect.objectContaining({ code: "agent_unavailable", severity: "block", ref: { type: "agent", id: "b" } })]);
    });

    it(`${label}: an MRM-refused intended agent still blocks`, () => {
      const r = evaluateDeployGate(input({ ...stack(agent("b", { mrmRefusal: "no model card", modelCardApproved: false })), requestedAgentIds }));
      expect(r.decision).toBe("deny");
      expect(r.agentsChecked).toEqual(["a", "b"]);
      expect(r.reasons).toEqual([expect.objectContaining({ code: "mrm_refused", severity: "block", ref: { type: "agent", id: "b" } })]);
    });

    it(`${label}: a clean stack is allowed and every intended agent is checked`, () => {
      expect(evaluateDeployGate(input({ ...stack(agent("b")), requestedAgentIds }))).toEqual({
        decision: "allow",
        reasons: [],
        agentsChecked: ["a", "b"],
      });
    });
  }

  it("a selection adds an off-stack agent to the check (and blocks on it), deduplicated", () => {
    const r = evaluateDeployGate(input({
      ...stack(agent("b")),
      requestedAgentIds: ["a", "x", "a"],
      agents: new Map([["a", agent("a")], ["b", agent("b")], ["x", agent("x")]]),
    }));
    expect(r.decision).toBe("deny");
    expect(r.agentsChecked).toEqual(["a", "b", "x"]);
    expect(r.reasons.map((x) => [x.code, x.ref?.id])).toEqual([["agent_not_in_approved_stack", "x"]]);
  });
});
