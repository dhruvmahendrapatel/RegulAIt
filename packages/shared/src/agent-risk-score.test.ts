/**
 * ADR-0339 — the agent risk score, table-tested. Each factor and combination has a case where it is the ONLY thing
 * present, so removing its rule fails that case; the combiner, bands, reach multiplier and the counterfactual fix
 * order are pinned by hand-computed values.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_OWNER_INACTIVE_DAYS,
  AGENT_RISK_BAND_EDGES,
  agentOwnershipFlag,
  AGENT_RISK_METHOD_VERSION,
  bandFor,
  reachBand,
  rankFixOptions,
  capabilityLegs,
  scoreAgentRisk,
  type AgentRiskCapability,
  type AgentRiskInput,
} from "./agent-risk-score.js";
import { NO_AUTONOMY_FACTS } from "./assurance.js";
import { NO_AUTONOMY_OBSERVATION, AUTONOMY_AGENTIC_TEST_CLASSES } from "./autonomy.js";
import { REDTEAM_CLASS_REFS, owaspReferences } from "./evaluator-catalog.js";

const tested = { runId: "r1", probes: 10, defeated: 0 };
/** a registry agent with nothing wrong: score 0 */
const clean = (): AgentRiskInput => ({
  kind: "agent",
  id: "00000000-0000-4000-8000-000000000001",
  name: "clean",
  ownership: "owned",
  guardrailModes: { prompt_injection: "block", jailbreak: "block" },
  modelBound: true,
  modelCardApproved: true,
  agenticTests: { indirect_prompt_injection: tested, tool_abuse: tested, excessive_agency: tested },
  testFreshnessDays: 30,
  customEndpoint: false,
  servedModelRelaxed: false,
  reach: { people: 0, dependents: 0, detail: "" },
  sodRule: null,
  capabilities: null,
});
const cleanBuilder = (): AgentRiskInput => ({
  ...clean(),
  kind: "builder_agent",
  builder: {
    facts: { ...NO_AUTONOMY_FACTS, ...NO_AUTONOMY_OBSERVATION },
    effectiveClass: "assist",
    declaredBelowObserved: false,
    monthlyLimitUsd: 50,
    unadmittedSkills: 0,
  },
  capabilities: [],
});

const present = (input: AgentRiskInput) => {
  const a = scoreAgentRisk(input);
  return { a, ids: [...a.factors, ...a.toxicCombinations].filter((f) => f.present).map((f) => f.id) };
};

describe("ADR-0339 agent risk score", () => {
  it("a clean agent scores 0, lists every factor as absent and has no fixes", () => {
    for (const input of [clean(), cleanBuilder()]) {
      const { a, ids } = present(input);
      expect(a.score).toBe(0);
      expect(a.band).toBe("low");
      expect(ids).toEqual([]);
      expect(a.fixes).toEqual([]);
      expect(a.methodVersion).toBe(AGENT_RISK_METHOD_VERSION);
      expect(a.factors.every((f) => f.evidence.length > 0 && f.max > 0)).toBe(true);
    }
    // builder-only factors are not listed for a registry agent (not applicable, not zero)
    expect(scoreAgentRisk(clean()).factors.map((f) => f.id)).not.toContain("computer_use");
    expect(scoreAgentRisk(cleanBuilder()).factors.map((f) => f.id)).toContain("computer_use");
  });

  const single: Array<[string, (i: AgentRiskInput) => void, number, boolean?]> = [
    ["guardrail_prompt_injection", (i) => void (i.guardrailModes = { ...i.guardrailModes, prompt_injection: "off" }), 8],
    ["guardrail_jailbreak", (i) => void (i.guardrailModes = { ...i.guardrailModes, jailbreak: "warn" }), 3],
    ["redteam_indirect_prompt_injection", (i) => void (i.agenticTests = { ...i.agenticTests, indirect_prompt_injection: { runId: null, probes: 0, defeated: 0 } }), 4],
    ["redteam_tool_abuse", (i) => void (i.agenticTests = { ...i.agenticTests, tool_abuse: { runId: "r", probes: 5, defeated: 2 } }), 8],
    ["redteam_excessive_agency", (i) => void (i.agenticTests = { ...i.agenticTests, excessive_agency: { runId: "r", probes: 0, defeated: 0 } }), 4],
    ["model_card_unapproved", (i) => void (i.modelCardApproved = false), 10],
    ["custom_endpoint", (i) => void (i.customEndpoint = true), 4],
    ["served_model_relaxed", (i) => void (i.servedModelRelaxed = true), 4],
    ["ownership", (i) => void (i.ownership = "orphaned"), 15],
    ["no_spend_limit", (i) => void (i.builder!.monthlyLimitUsd = null), 6, true],
    ["autonomy_class", (i) => void (i.builder!.effectiveClass = "delegated"), 8, true],
    ["autonomy_declared_below_observed", (i) => void (i.builder!.declaredBelowObserved = true), 8, true],
    ["write_tools_without_ask_first", (i) => void (i.builder!.facts.writeToolsWithoutAskFirst = 5), 16, true],
    ["computer_use", (i) => void (i.builder!.facts.computerUse = true), 10, true],
    ["sub_agents", (i) => void (i.builder!.facts.subAgents = 2), 6, true],
    ["inbound_channels", (i) => void (i.builder!.facts.inboundChannels = 1), 5, true],
    ["schedules", (i) => void (i.builder!.facts.schedules = 4), 6, true],
    ["unadmitted_skills", (i) => void (i.builder!.unadmittedSkills = 1), 4, true],
    ["sod_rule_held_by_agent", (i) => void (i.sodRule = { id: "s", name: "pay and approve" }), 15],
  ];
  it.each(single)("factor %s is present alone, with its published points", (id, mutate, points, builderOnly) => {
    const input = builderOnly ? cleanBuilder() : clean();
    mutate(input);
    const { a, ids } = present(input);
    expect(ids).toEqual([id]);
    expect(a.score).toBe(points);
    expect(a.fixes).toHaveLength(1);
    expect(a.fixes[0]!.points).toBe(points);
  });

  it("ownership scores owned 0, inactive 8, unowned 10, orphaned 15", () => {
    const pts = (["owned", "inactive", "unowned", "orphaned"] as const).map((o) => scoreAgentRisk({ ...clean(), ownership: o }).score);
    expect(pts).toEqual([0, 8, 10, 15]);
  });

  it("the ownership flag: unowned, orphaned before inactive, inactive past the window or never active", () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const day = 86_400_000;
    expect(agentOwnershipFlag(null, false, now, now)).toBe("unowned");
    expect(agentOwnershipFlag("u", true, now, now)).toBe("orphaned");
    expect(agentOwnershipFlag("u", false, null, now)).toBe("inactive");
    expect(agentOwnershipFlag("u", false, new Date(now.getTime() - AGENT_OWNER_INACTIVE_DAYS * day), now)).toBe("owned");
    expect(agentOwnershipFlag("u", false, new Date(now.getTime() - AGENT_OWNER_INACTIVE_DAYS * day - 1), now)).toBe("inactive");
  });

  it("unprotected guardrail modes score off 8, log 6, warn 3, block 0", () => {
    const pts = (["off", "log", "warn", "block"] as const).map((m) => {
      const i = clean();
      i.guardrailModes = { prompt_injection: m, jailbreak: "block" };
      return scoreAgentRisk(i).score;
    });
    expect(pts).toEqual([8, 6, 3, 0]);
  });

  it("an agent with no model binding is untested in every class and has no sign-off", () => {
    const i = clean();
    i.modelBound = false;
    i.modelCardApproved = false;
    const { a, ids } = present(i);
    expect(ids).toEqual(["redteam_indirect_prompt_injection", "redteam_tool_abuse", "redteam_excessive_agency", "model_card_unapproved"]);
    expect(a.score).toBe(4 * 3 + 10);
  });

  const cap = (over: Partial<AgentRiskCapability> & Pick<AgentRiskCapability, "id" | "name">): AgentRiskCapability => ({
    kind: "connector",
    reads: false,
    writes: false,
    askFirst: false,
    sourceTier: "trusted",
    openWorld: false,
    destructive: false,
    sharedWith: 0,
    ...over,
  });
  const crm = () => cap({ id: "c1", name: "crm read", reads: true });
  const mail = () => cap({ id: "c2", name: "mail send", writes: true });
  const inbox = () => cap({ kind: "channel", id: "ch1", name: "slack inbound", sourceTier: null });
  const trifecta = () => {
    const i = cleanBuilder();
    i.capabilities = [crm(), mail(), inbox()];
    return i;
  };

  it("addendum: the lethal trifecta needs private data, untrusted content and external communication; each leg names its members", () => {
    const { a, ids } = present(trifecta());
    expect(ids).toEqual(["lethal_trifecta"]);
    const t = a.toxicCombinations.find((c) => c.id === "lethal_trifecta")!;
    expect(t.legs!.map((l) => [l.id, l.members.map((m) => m.name)])).toEqual([
      ["private_data", ["crm read"]],
      ["untrusted_content", ["slack inbound"]],
      ["external_communication", ["mail send"]],
    ]);
    expect(t.evidence).toContain("slack inbound");
    expect(a.score).toBe(15);
    // remove any one leg and the combination is broken
    for (const drop of ["c1", "c2", "ch1"]) {
      const i = trifecta();
      i.capabilities = i.capabilities!.filter((c) => c.id !== drop);
      expect(present(i).ids).not.toContain("lethal_trifecta");
    }
    // Ask-first on the write breaks the external-communication leg
    const af = trifecta();
    af.capabilities = [crm(), { ...mail(), askFirst: true }, inbox()];
    expect(present(af).ids).toEqual([]);
  });

  it("addendum: an unclassified source counts as untrusted, and an open-world read alone carries data out", () => {
    const i = cleanBuilder();
    // one MCP fetch tool from a source nobody classified: reads, is untrusted, and reaches the open world
    i.capabilities = [cap({ kind: "mcp_tool", id: "t1", name: "fetch", reads: true, sourceTier: null, openWorld: true })];
    expect(present(i).ids).toEqual(["lethal_trifecta"]);
    // an admitted definition that says it does not reach the open world, from a trusted source: no combination
    i.capabilities = [cap({ kind: "mcp_tool", id: "t1", name: "fetch", reads: true, sourceTier: "trusted", openWorld: false })];
    expect(present(i).ids).toEqual([]);
    // standard counts as classified; untrusted does not
    const legs = capabilityLegs([cap({ id: "s", name: "s", reads: true, sourceTier: "standard" }), cap({ id: "u", name: "u", reads: true, sourceTier: "untrusted" })]);
    expect(legs.untrusted_content.members.map((m) => m.name)).toEqual(["u"]);
  });

  it("addendum: untrusted content + an unconfirmed destructive write; registry agents without tools are not applicable", () => {
    const i = cleanBuilder();
    i.capabilities = [inbox(), cap({ kind: "mcp_tool", id: "d1", name: "drop table", writes: true, destructive: true })];
    const { ids } = present(i);
    expect(ids).toContain("untrusted_input_unconfirmed_destructive");
    i.capabilities = [inbox(), cap({ kind: "mcp_tool", id: "d1", name: "drop table", writes: true, destructive: true, askFirst: true })];
    expect(present(i).ids).not.toContain("untrusted_input_unconfirmed_destructive");
    const reg = scoreAgentRisk(clean());
    for (const id of ["lethal_trifecta", "untrusted_input_unconfirmed_destructive"]) {
      const t = reg.toxicCombinations.find((c) => c.id === id)!;
      expect(t.present).toBe(false);
      expect(t.evidence).toContain("not applicable");
    }
    // a registry agent with an identity has no Ask-first switch (null): its writes are unconfirmed
    const r = clean();
    r.capabilities = [crm(), { ...mail(), askFirst: null }, { ...inbox() }];
    expect(present(r).ids).toEqual(["lethal_trifecta"]);
  });

  it("addendum: fix options break one leg each, fewest members first, Ask-first before removal, then the smaller blast radius", () => {
    const i = trifecta();
    i.capabilities = [crm(), cap({ id: "c3", name: "crm2 read", reads: true, sharedWith: 1 }), { ...mail(), sharedWith: 4 }, { ...inbox(), sharedWith: 2 }];
    const t = scoreAgentRisk(i).toxicCombinations.find((c) => c.id === "lethal_trifecta")!;
    expect(t.fixOptions!.map((o) => [o.rank, o.action, o.leg, o.cost, o.sharedWith])).toEqual([
      [1, "ask_first", "external_communication", 1, 4],
      [2, "remove", "untrusted_content", 1, 2],
      [3, "remove", "external_communication", 1, 4],
      [4, "remove", "private_data", 2, 1],
    ]);
    expect(t.fix.title).toBe(t.fixOptions![0]!.title);
    // Ask-first is offered only when every member of the leg is a write with an Ask-first switch
    const legs = capabilityLegs([cap({ kind: "mcp_tool", id: "o", name: "open", reads: true, openWorld: true }), mail()]);
    expect(rankFixOptions([legs.external_communication], [cap({ kind: "mcp_tool", id: "o", name: "open", reads: true, openWorld: true }), mail()]).map((o) => o.action)).toEqual(["remove"]);
  });

  it("addendum: combination points are weighted by the reach band (blast radius)", () => {
    const i = trifecta();
    i.reach = { people: 60, dependents: 0, detail: "" };
    expect(scoreAgentRisk(i).score).toBe(Math.round(15 * 1.5));
    expect(AGENT_RISK_METHOD_VERSION).toBe("adr0339-v3");
  });

  it("reach multiplies exposure and weights toxic points; the bands are published", () => {
    expect([0, 1, 2, 10, 11, 50, 51, 500].map((n) => reachBand(n, 0).multiplier)).toEqual([1, 1, 1.15, 1.15, 1.3, 1.3, 1.5, 1.5]);
    expect(reachBand(5, 6).multiplier).toBe(1.3);
    const i = clean();
    i.ownership = "orphaned"; // 15
    i.modelCardApproved = false; // 10
    i.sodRule = { id: "s", name: "r" }; // +15 after the multiplier
    i.reach = { people: 60, dependents: 0, detail: "60 people" };
    const a = scoreAgentRisk(i);
    expect(a.exposure).toBe(25);
    expect(a.reach.multiplier).toBe(1.5);
    expect(a.score).toBe(Math.round(25 * 1.5) + Math.round(15 * 1.5)); // v3: combinations weighted by reach
    expect(a.band).toBe("high");
    expect(bandFor(AGENT_RISK_BAND_EDGES.medium - 1)).toBe("low");
    expect(bandFor(AGENT_RISK_BAND_EDGES.medium)).toBe("medium");
    expect(bandFor(AGENT_RISK_BAND_EDGES.critical)).toBe("critical");
  });

  it("fixes are ranked by how far the score drops, ties by id, and the score is capped at 100", () => {
    const i = cleanBuilder();
    i.ownership = "orphaned"; // 15
    i.builder!.facts.computerUse = true; // 10
    i.customEndpoint = true; // 4
    i.servedModelRelaxed = true; // 4
    const a = scoreAgentRisk(i);
    expect(a.fixes.map((f) => [f.rank, f.source, f.points])).toEqual([
      [1, "ownership", 15],
      [2, "computer_use", 10],
      [3, "custom_endpoint", 4],
      [4, "served_model_relaxed", 4],
    ]);
    const worst = cleanBuilder();
    Object.assign(worst, { ownership: "orphaned", modelBound: false, modelCardApproved: false, customEndpoint: true, servedModelRelaxed: true, sodRule: { id: "s", name: "r" } });
    worst.guardrailModes = { prompt_injection: "off", jailbreak: "off" };
    Object.assign(worst.builder!, { effectiveClass: "autonomous", declaredBelowObserved: true, monthlyLimitUsd: null, unadmittedSkills: 9 });
    Object.assign(worst.builder!.facts, { computerUse: true, writeToolsWithoutAskFirst: 9, subAgents: 9, inboundChannels: 9, schedules: 9, tools: 9 });
    worst.reach = { people: 1000, dependents: 0, detail: "" };
    const w = scoreAgentRisk(worst);
    expect(w.exposure).toBe(100);
    expect(w.score).toBe(100);
    expect(w.band).toBe("critical");
  });

  it("is deterministic: the same input gives the same assessment", () => {
    const i = cleanBuilder();
    i.builder!.facts.subAgents = 1;
    expect(JSON.stringify(scoreAgentRisk(i))).toBe(JSON.stringify(scoreAgentRisk(structuredClone(i))));
  });

  it("cites only OWASP ids the catalog resolves, and the red-team classes use the catalog's own refs", () => {
    const known = new Set(owaspReferences().map((r) => r.id));
    const i = cleanBuilder();
    const a = scoreAgentRisk(i);
    for (const f of [...a.factors, ...a.toxicCombinations]) {
      expect(f.owasp.length).toBeGreaterThan(0);
      for (const id of f.owasp) expect(known.has(id), `${f.id} cites ${id}`).toBe(true);
    }
    for (const cls of AUTONOMY_AGENTIC_TEST_CLASSES) {
      const factor = a.factors.find((f) => f.id === `redteam_${cls}`)!;
      expect([...factor.owasp].sort()).toEqual([...REDTEAM_CLASS_REFS[cls].owasp].sort());
    }
  });

  it("stores no OWASP risk names (identifiers only, ADR-0243 decision 2)", () => {
    const names = owaspReferences().map((r) => r.name.replace(/^ASI\d+:\s*/, "").toLowerCase());
    const text = JSON.stringify(scoreAgentRisk(cleanBuilder())).toLowerCase();
    for (const n of names) expect(text.includes(n), n).toBe(false);
  });
});
