/**
 * ADR-0180 §5 (A8) — the autonomy derivation and floors, table-tested. Each
 * derivation rule has a row that is the ONLY fact set, so the row fails when
 * that rule is removed (the red proof).
 */
import { describe, expect, it } from "vitest";
import {
  AUTONOMY_FLOORS,
  AUTONOMY_RULES,
  agenticOwaspId,
  autonomyReasons,
  checkAutonomyFloors,
  declareAutonomySchema,
  declaredBelowObserved,
  deriveAutonomyClass,
  effectiveAutonomyClass,
  floorConditions,
  floorsForClass,
  mergeAutonomyFacts,
  type AutonomyFloorEvidence,
  type AutonomyObservedFacts,
} from "./autonomy.js";
import { NO_AUTONOMY_FACTS, measuredConditionInputSchema, type AutonomyClass } from "./assurance.js";
import { OWASP_AGENTIC_TOP_10_MAPPING } from "./owasp-framework-mappings.js";

const none: AutonomyObservedFacts = { ...NO_AUTONOMY_FACTS, tools: 0, unattendedRuns: 0, unconfirmedWrites: 0, toolCalls: 0 };
const f = (over: Partial<AutonomyObservedFacts>): AutonomyObservedFacts => ({ ...none, ...over });

describe("deriveAutonomyClass: one row per rule", () => {
  const rows: Array<[string, Partial<AutonomyObservedFacts>, AutonomyClass]> = [
    ["nothing at all", {}, "assist"],
    ["R1 an enabled schedule", { schedules: 1 }, "autonomous"],
    ["R2 an inbound channel", { inboundChannels: 1 }, "autonomous"],
    ["R3 an observed unattended run", { unattendedRuns: 2 }, "autonomous"],
    ["R4 a sub-agent", { subAgents: 1 }, "delegated"],
    ["R5 a write tool without Ask-first", { writeToolsWithoutAskFirst: 1, tools: 1 }, "delegated"],
    ["R6 computer use", { computerUse: true }, "delegated"],
    ["R7 an observed unconfirmed write", { unconfirmedWrites: 1 }, "delegated"],
    ["R8 a tool (asks first)", { tools: 2 }, "supervised"],
    ["R9 an observed tool call", { toolCalls: 3 }, "supervised"],
  ];
  for (const [label, facts, cls] of rows) {
    it(`${label} -> ${cls}`, () => {
      expect(deriveAutonomyClass(f(facts))).toBe(cls);
    });
  }

  it("takes the HIGHEST class any rule reaches, whatever the order of facts", () => {
    expect(deriveAutonomyClass(f({ tools: 3, subAgents: 1, schedules: 1 }))).toBe("autonomous");
    expect(deriveAutonomyClass(f({ tools: 3, computerUse: true }))).toBe("delegated");
  });

  it("reads the P0 facts alone (observation absent = nothing observed)", () => {
    expect(deriveAutonomyClass({ ...NO_AUTONOMY_FACTS })).toBe("assist");
    expect(deriveAutonomyClass({ ...NO_AUTONOMY_FACTS, schedules: 1 })).toBe("autonomous");
  });

  it("is deterministic: same facts, same class and reasons", () => {
    const x = f({ schedules: 1, subAgents: 2, toolCalls: 4 });
    expect(deriveAutonomyClass(x)).toBe(deriveAutonomyClass({ ...x }));
    expect(autonomyReasons(x)).toEqual(autonomyReasons({ ...x }));
  });

  it("every rule explains itself in plain language, with its count", () => {
    const r = autonomyReasons(f({ schedules: 2, writeToolsWithoutAskFirst: 1 }));
    expect(r.map((x) => x.ruleId)).toEqual(["enabled_schedule", "write_tool_without_ask_first"]);
    expect(r[0]!.text).toBe("It has 2 enabled schedules, so it starts work on its own timer.");
    expect(r[1]!.text).toBe("1 tool that can change data does not ask a person first.");
    expect(new Set(AUTONOMY_RULES.map((x) => x.id)).size).toBe(AUTONOMY_RULES.length);
  });
});

describe("declared vs observed", () => {
  it("flags a declaration below the observed class, and only that", () => {
    expect(declaredBelowObserved("supervised", "autonomous")).toBe(true);
    expect(declaredBelowObserved("assist", "supervised")).toBe(true);
    expect(declaredBelowObserved("autonomous", "autonomous")).toBe(false);
    expect(declaredBelowObserved("autonomous", "assist")).toBe(false);
    expect(declaredBelowObserved(null, "autonomous")).toBe(false);
  });
  it("the floor follows the stricter class; undeclared = observed", () => {
    expect(effectiveAutonomyClass("autonomous", "supervised")).toBe("autonomous");
    expect(effectiveAutonomyClass("assist", "delegated")).toBe("delegated");
    expect(effectiveAutonomyClass("supervised", null)).toBe("supervised");
  });
  it("merges several agents' facts: counts add, computer use is any", () => {
    const m = mergeAutonomyFacts([f({ schedules: 1, tools: 2 }), f({ computerUse: true, tools: 1 })]);
    expect(m).toMatchObject({ schedules: 1, tools: 3, computerUse: true });
  });
  it("the declaration needs a note to declare, none to withdraw", () => {
    expect(declareAutonomySchema.safeParse({ class: "supervised" }).success).toBe(false);
    expect(declareAutonomySchema.safeParse({ class: "supervised", note: "  " }).success).toBe(false);
    expect(declareAutonomySchema.safeParse({ class: "supervised", note: "reviewed" }).success).toBe(true);
    expect(declareAutonomySchema.safeParse({ class: null }).success).toBe(true);
    expect(declareAutonomySchema.safeParse({ class: "rogue", note: "x" }).success).toBe(false);
    expect(declareAutonomySchema.safeParse({ class: null, extra: 1 }).success).toBe(false);
  });
});

const goodTests = { runId: "r", finishedAt: "2026-10-01T00:00:00Z", probes: 5, defeated: 0 };
const strong: AutonomyFloorEvidence = {
  guardrailModes: { prompt_injection: "block", jailbreak: "block" },
  modelCardApproved: true,
  agenticTests: { indirect_prompt_injection: goodTests, tool_abuse: goodTests, excessive_agency: goodTests },
  testFreshnessDays: 30,
  monthlyLimitUsd: 50,
  writeToolsWithoutAskFirst: 0,
};
const unmetIds = (cls: AutonomyClass, ev: AutonomyFloorEvidence) =>
  checkAutonomyFloors(cls, ev)
    .filter((c) => !c.met)
    .map((c) => c.id);

describe("control floors", () => {
  it("are cumulative by class", () => {
    expect(floorsForClass("assist")).toEqual([]);
    expect(floorsForClass("supervised").map((x) => x.id)).toEqual(["guardrails_warn"]);
    expect(floorsForClass("delegated").map((x) => x.id)).toEqual([
      "guardrails_warn",
      "guardrails_block",
      "model_card_approved",
      "agentic_redteam_measured",
    ]);
    expect(floorsForClass("autonomous")).toHaveLength(AUTONOMY_FLOORS.length);
  });

  it("all met with strong evidence, at every class", () => {
    for (const c of ["assist", "supervised", "delegated", "autonomous"] as const) expect(unmetIds(c, strong)).toEqual([]);
  });

  const rows: Array<[string, Partial<AutonomyFloorEvidence>, AutonomyClass, string[]]> = [
    ["guardrails at log fail supervised", { guardrailModes: { prompt_injection: "log", jailbreak: "block" } }, "supervised", ["guardrails_warn"]],
    ["guardrails at warn pass supervised", { guardrailModes: { prompt_injection: "warn", jailbreak: "warn" } }, "supervised", []],
    ["guardrails at warn fail delegated", { guardrailModes: { prompt_injection: "warn", jailbreak: "block" } }, "delegated", ["guardrails_block"]],
    ["no approved model card fails delegated", { modelCardApproved: false }, "delegated", ["model_card_approved"]],
    ["no approved model card is not a supervised floor", { modelCardApproved: false }, "supervised", []],
    [
      "an unmeasured agentic class fails delegated",
      { agenticTests: { ...strong.agenticTests, tool_abuse: { runId: null, finishedAt: null, probes: 0, defeated: 0 } } },
      "delegated",
      ["agentic_redteam_measured"],
    ],
    [
      "a defeated agentic class passes delegated (measured) but fails autonomous",
      { agenticTests: { ...strong.agenticTests, excessive_agency: { ...goodTests, defeated: 1 } } },
      "delegated",
      [],
    ],
    [
      "a defeated agentic class fails autonomous",
      { agenticTests: { ...strong.agenticTests, excessive_agency: { ...goodTests, defeated: 1 } } },
      "autonomous",
      ["agentic_redteam_passing"],
    ],
    ["no monthly limit fails autonomous", { monthlyLimitUsd: null }, "autonomous", ["monthly_limit_set"]],
    ["no monthly limit is not a delegated floor", { monthlyLimitUsd: null }, "delegated", []],
    ["an unasked write tool fails autonomous", { writeToolsWithoutAskFirst: 2 }, "autonomous", ["writes_ask_first_when_unattended"]],
    ["an unasked write tool is not a delegated floor", { writeToolsWithoutAskFirst: 2 }, "delegated", []],
  ];
  for (const [label, over, cls, expected] of rows) {
    it(label, () => {
      expect(unmetIds(cls, { ...strong, ...over })).toEqual(expected);
    });
  }

  it("an unmet floor becomes a valid, blocking autonomy_floor condition", () => {
    const weak: AutonomyFloorEvidence = {
      ...strong,
      guardrailModes: { prompt_injection: "log", jailbreak: "log" },
      modelCardApproved: false,
      agenticTests: {
        indirect_prompt_injection: { runId: null, finishedAt: null, probes: 0, defeated: 0 },
        tool_abuse: { ...goodTests, defeated: 2 },
        excessive_agency: goodTests,
      },
      monthlyLimitUsd: null,
      writeToolsWithoutAskFirst: 1,
    };
    const agent = { id: "00000000-0000-4000-8000-0000000000aa", name: "Night sweeper" };
    const conds = checkAutonomyFloors("autonomous", weak)
      .filter((c) => !c.met)
      .flatMap((c) => floorConditions(c, agent, "autonomous"));
    for (const c of conds) {
      expect(measuredConditionInputSchema.safeParse(c).success, JSON.stringify(c)).toBe(true);
      expect(c.kind).toBe("autonomy_floor");
      expect(c.blocking).toBe(true);
      expect(c.params["builderAgentId"]).toBe(agent.id);
    }
    expect(conds.map((c) => c.params["floor"])).toEqual([
      "guardrails_warn",
      "guardrails_block",
      "model_card_approved",
      "agentic_redteam_measured",
      "monthly_limit_set",
      "agentic_redteam_passing",
      "agentic_redteam_passing",
      "writes_ask_first_when_unattended",
    ]);
    const measured = conds.find((c) => c.params["floor"] === "agentic_redteam_measured")!;
    expect(measured).toMatchObject({ metric: "redteam_asr", operator: "lte", threshold: 100 });
    expect(measured.params["testClass"]).toBe("owasp:agentic:asi01");
    expect(conds.find((c) => c.params["floor"] === "guardrails_block")).toMatchObject({ metric: "guardrail_mode", operator: "gte", threshold: 3 });
    expect(conds[0]!.text).toBe("Autonomy floor (autonomous) for builder agent 'Night sweeper': prompt-injection and jailbreak guardrails at least warn");
  });

  it("names agentic test classes only by ids in the vendored OWASP table", () => {
    for (const c of ["indirect_prompt_injection", "tool_abuse", "excessive_agency"] as const) {
      const id = agenticOwaspId(c);
      expect(id).not.toBeNull();
      expect(OWASP_AGENTIC_TOP_10_MAPPING[id!]).toBeDefined();
    }
  });
});
