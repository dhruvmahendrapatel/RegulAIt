import { describe, expect, it } from "vitest";
import {
  CONTAINMENT_AUTO_THRESHOLD_DEFAULT,
  CONTAINMENT_MACHINE,
  autonomyGapSeverity,
  containmentSignalFromAlert,
  containmentThresholdLooser,
  decideContainmentAction,
} from "./rogue-containment.js";
import { STATE_MACHINES } from "./state-machines.js";
import { APPROVAL_OBJECT_TYPES } from "./approval-binding.js";

const AGENT = "11111111-2222-4333-8444-555555555555";

describe("ADR-0366 rogue-agent containment (pure)", () => {
  it("secure default: automatic containment is on for critical signals only", () => {
    expect(CONTAINMENT_AUTO_THRESHOLD_DEFAULT).toBe("critical");
    expect(decideContainmentAction("critical", "critical")).toBe("auto_contain");
    expect(decideContainmentAction("high", "critical")).toBe("propose");
    expect(decideContainmentAction("low", "critical")).toBe("propose");
  });

  it("a lower threshold contains more; off never contains automatically", () => {
    expect(decideContainmentAction("high", "high")).toBe("auto_contain");
    expect(decideContainmentAction("medium", "high")).toBe("propose");
    expect(decideContainmentAction("low", "low")).toBe("auto_contain");
    expect(decideContainmentAction("critical", "off")).toBe("propose");
  });

  it("strictness: off and a raised threshold are looser; a lowered threshold only tightens", () => {
    expect(containmentThresholdLooser("off", "critical")).toBe(true);
    expect(containmentThresholdLooser("critical", "high")).toBe(true);
    expect(containmentThresholdLooser("high", "critical")).toBe(false);
    expect(containmentThresholdLooser("critical", "critical")).toBe(false);
  });

  it("autonomy gap severity: one class medium, two high, assist observed autonomous critical", () => {
    expect(autonomyGapSeverity("supervised", "delegated")).toBe("medium");
    expect(autonomyGapSeverity("assist", "delegated")).toBe("high");
    expect(autonomyGapSeverity("assist", "autonomous")).toBe("critical");
    expect(autonomyGapSeverity("delegated", "supervised")).toBeNull();
    expect(autonomyGapSeverity("nonsense", "autonomous")).toBeNull();
  });

  it("maps autonomy_declared_below_observed to a builder-agent signal", () => {
    const s = containmentSignalFromAlert({
      id: "a1",
      ruleId: "autonomy_declared_below_observed",
      subjectKey: `builder_agent:${AGENT}`,
      severity: "medium",
      detail: { agentId: AGENT, agentName: "Ops bot", declared: "assist", observed: "autonomous", reasons: ["schedule"] },
    });
    expect(s).toMatchObject({
      source: { kind: "monitor", ruleId: "autonomy_declared_below_observed", refId: "a1" },
      subject: { kind: "builder_agent", id: AGENT },
      severity: "critical",
      evidence: { declared: "assist", observed: "autonomous", reasons: ["schedule"] },
    });
    expect(s!.explanation).toContain("'Ops bot'");
  });

  it("maps classical_model_drift only when the card is bound to an agent", () => {
    const base = { id: "a2", ruleId: "classical_model_drift", subjectKey: "x", severity: "high" };
    expect(containmentSignalFromAlert({ ...base, detail: { cardId: "c", monitorId: "m" } })).toBeNull();
    expect(containmentSignalFromAlert({ ...base, detail: { agentId: AGENT, cardId: "c", monitorId: "m" } })).toMatchObject({
      subject: { kind: "agent", id: AGENT },
      severity: "high",
    });
  });

  it("unregistered traffic and every other rule produce no signal (no agent to contain)", () => {
    expect(
      containmentSignalFromAlert({ id: "a3", ruleId: "unregistered_ai_traffic", subjectKey: `project:${AGENT}`, severity: "medium", detail: {} }),
    ).toBeNull();
    expect(containmentSignalFromAlert({ id: "a4", ruleId: "stale_credentials", subjectKey: "k", severity: "medium", detail: { agentId: AGENT } })).toBeNull();
    // a malformed agent id is not trusted
    expect(
      containmentSignalFromAlert({ id: "a5", ruleId: "autonomy_declared_below_observed", subjectKey: "k", severity: "medium", detail: { agentId: "x", declared: "assist", observed: "autonomous" } }),
    ).toBeNull();
  });

  it("the lifecycle: proposals are decided once, containments are released once, and terminal states stay terminal", () => {
    expect(CONTAINMENT_MACHINE.next("proposed", "approve")).toBe("contained");
    expect(CONTAINMENT_MACHINE.next("proposed", "decline")).toBe("declined");
    // a release is a request a different administrator approves (owner decision 2026-11-21)
    expect(CONTAINMENT_MACHINE.next("contained", "request_release")).toBe("release_pending");
    expect(CONTAINMENT_MACHINE.next("release_pending", "approve_release")).toBe("released");
    expect(CONTAINMENT_MACHINE.next("release_pending", "deny_release")).toBe("contained");
    expect(CONTAINMENT_MACHINE.can("contained", "approve_release")).toBe(false);
    expect(CONTAINMENT_MACHINE.can("released", "request_release")).toBe(false);
    expect(CONTAINMENT_MACHINE.can("declined", "approve")).toBe(false);
    expect(CONTAINMENT_MACHINE.can("contained", "approve")).toBe(false);
    expect(STATE_MACHINES.agent_containment).toBe(CONTAINMENT_MACHINE);
    expect(APPROVAL_OBJECT_TYPES).toContain("agent_containment");
  });
});
