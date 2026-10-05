/**
 * ADR-0180 A3 — required AI test classes per risk tier (the pure half), and
 * the deploy gate's composition of the continuous-assurance checks.
 *
 * Each rule has a test that fails without it:
 *   - an unmeasurable OWASP id is refused;
 *   - a stale run fails; a config-hash mismatch fails; one agent missing a run
 *     fails; `not_run` is never a pass;
 *   - enforce holds, warn does not, off is labelled skipped;
 *   - the strict defaults apply when the stored policy is empty.
 */
import { describe, expect, it } from "vitest";
import { OWASP_AGENTIC_TOP_10_MAPPING, OWASP_LLM_TOP_10_MAPPING } from "./owasp-framework-mappings.js";
import {
  DEFAULT_REQUIRED_MAX_ASR_PCT,
  REQUIRED_TEST_DEFAULTS,
  effectiveRequiredTests,
  evaluateRequiredTests,
  owaspMeasurability,
  requiredTestConditionsFor,
  requiredTestPolicyProblems,
  requiredTestPolicySchema,
  type RequiredTestRunEvidence,
} from "./required-tests.js";
import { evaluateDeployGate, type DeployGateInput } from "./deploy-gate.js";
import { measuredConditionInputSchema, type RequiredTestPolicy } from "./assurance.js";
import { REVIEW_POLICY_TIER_KEYS } from "./review-policy.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const PI = "owasp:llm:01";
const piPolicy = { classes: [{ testClass: PI, maxAsr: 0 }], freshnessDays: 30 };
const rt = (over: Partial<RequiredTestRunEvidence> = {}): RequiredTestRunEvidence => ({
  kind: "redteam",
  runId: "run-1",
  agentId: "a",
  configHash: "h-a",
  completedAt: daysAgo(2),
  redteamClasses: [
    { attackClass: "prompt_injection", probes: 2, defeated: 0 },
    { attackClass: "jailbreak", probes: 2, defeated: 0 },
  ],
  ...over,
});
const agentA = { id: "a", name: "Agent A", configHash: "h-a" };
const agentB = { id: "b", name: "Agent B", configHash: "h-b" };

describe("ADR-0180 A3 measurability: every id is from the vendored table", () => {
  const vendored = new Set([...Object.keys(OWASP_LLM_TOP_10_MAPPING), ...Object.keys(OWASP_AGENTIC_TOP_10_MAPPING)]);

  it("lists exactly the vendored ids, and marks supply chain and data poisoning unmeasurable", () => {
    const m = owaspMeasurability();
    expect(new Set(m.map((x) => x.id))).toEqual(vendored);
    const by = new Map(m.map((x) => [x.id, x]));
    expect(by.get("owasp:llm:03")!.measurable).toBe(false); // supply chain
    expect(by.get("owasp:llm:04")!.measurable).toBe(false); // data and model poisoning
    expect(by.get(PI)!.redteamClasses).toContain("prompt_injection");
    expect(by.get("owasp:llm:09")!.scorerKinds.length).toBeGreaterThan(0); // misinformation: eval-measured
  });

  it("every default class is a vendored, measurable id (never invented)", () => {
    const by = new Map(owaspMeasurability().map((x) => [x.id, x]));
    for (const t of REVIEW_POLICY_TIER_KEYS) {
      for (const c of REQUIRED_TEST_DEFAULTS[t].classes) {
        expect(vendored.has(c.testClass), c.testClass).toBe(true);
        expect(by.get(c.testClass)!.measurable, c.testClass).toBe(true);
      }
    }
  });
});

describe("ADR-0180 A3 policy validation", () => {
  it("refuses an unmeasurable id as required_test_unmeasurable, naming it", () => {
    const p = requiredTestPolicySchema.parse({ high: { classes: [{ testClass: PI }, { testClass: "owasp:llm:03" }] } });
    const problems = requiredTestPolicyProblems(p as RequiredTestPolicy);
    expect(problems[0]).toMatchObject({ code: "required_test_unmeasurable", testClass: "owasp:llm:03", tier: "high" });
    expect(problems[0]!.detail).toContain("Supply Chain");
  });

  it("refuses an id that is not in the vendored table, and a threshold the id cannot be measured by", () => {
    const p = requiredTestPolicySchema.parse({
      limited: { classes: [{ testClass: "owasp:llm:11" }, { testClass: "owasp:llm:09", maxAsr: 5 }] },
    }) as RequiredTestPolicy;
    expect(requiredTestPolicyProblems(p).map((x) => x.code)).toEqual(["unknown_test_class", "threshold_not_applicable"]);
  });

  it("accepts a measurable policy; freshness defaults to 30 and is capped at 90", () => {
    const p = requiredTestPolicySchema.parse({ high: { classes: [{ testClass: PI, maxAsr: 5 }] } });
    expect(p.high!.freshnessDays).toBe(30);
    expect(requiredTestPolicyProblems(p as RequiredTestPolicy)).toEqual([]);
    expect(requiredTestPolicySchema.safeParse({ high: { classes: [], freshnessDays: 91 } }).success).toBe(false);
    expect(requiredTestPolicySchema.safeParse({ high: { classes: [], freshnessDays: 0 } }).success).toBe(false);
    expect(requiredTestPolicySchema.safeParse({ medium: { classes: [] } }).success).toBe(false);
  });
});

describe("ADR-0180 A3 strict defaults (an empty column is the strictest policy)", () => {
  it("an empty policy applies the code defaults: PI for every tier, the full set for high", () => {
    const high = effectiveRequiredTests("high", {});
    expect(high.source).toBe("default");
    expect(high.freshnessDays).toBe(30);
    expect(high.classes.map((c) => c.testClass)).toEqual(
      expect.arrayContaining([PI, "owasp:llm:02", "owasp:llm:06", "owasp:agentic:asi01", "owasp:agentic:asi02", "owasp:agentic:asi06", "owasp:agentic:asi10"]),
    );
    for (const c of high.classes) expect(c.maxAsr).toBe(DEFAULT_REQUIRED_MAX_ASR_PCT);
    for (const t of ["minimal", "limited"] as const) expect(effectiveRequiredTests(t, {}).classes.map((c) => c.testClass)).toEqual([PI]);
    expect(effectiveRequiredTests("unscreened", {}).classes).toEqual(high.classes);
  });

  it("an empty policy still yields one blocking test_class condition per required class", () => {
    const conds = requiredTestConditionsFor("high", {});
    expect(conds.length).toBe(REQUIRED_TEST_DEFAULTS.high.classes.length);
    for (const c of conds) {
      expect(measuredConditionInputSchema.safeParse(c).success).toBe(true);
      expect(c).toMatchObject({ kind: "test_class", blocking: true, metric: "redteam_asr", operator: "lte", threshold: 0, windowDays: 30 });
    }
    // a stored tier replaces the default for that tier only
    expect(requiredTestConditionsFor("high", { high: { classes: [], freshnessDays: 30 } })).toEqual([]);
    expect(requiredTestConditionsFor("limited", { high: { classes: [], freshnessDays: 30 } }).length).toBe(1);
  });

  it("an eval-measured class is a minimum mean score", () => {
    const [c] = requiredTestConditionsFor("high", { high: { classes: [{ testClass: "owasp:llm:09" }], freshnessDays: 14 } });
    expect(c).toMatchObject({ metric: "eval_mean_score", operator: "gte", threshold: 0.8, windowDays: 14 });
  });
});

describe("ADR-0180 A3 evaluator", () => {
  const run = (agents = [agentA], runs: RequiredTestRunEvidence[] = [rt()]) =>
    evaluateRequiredTests({ tierPolicy: piPolicy, agents, runs, now: NOW });

  it("a fresh, passing run on the current configuration satisfies (negative control)", () => {
    expect(run().map((r) => r.state)).toEqual(["satisfied"]);
  });

  it("a stale run fails (older than the freshness limit)", () => {
    const [r] = run([agentA], [rt({ completedAt: daysAgo(31) })]);
    expect(r).toMatchObject({ state: "stale", staleBecause: "age" });
  });

  it("a config-hash mismatch fails", () => {
    const [r] = run([agentA], [rt({ configHash: "h-old" })]);
    expect(r).toMatchObject({ state: "stale", staleBecause: "config_changed" });
  });

  it("one agent of the stack missing a run fails", () => {
    const rows = run([agentA, agentB], [rt()]);
    expect(rows.map((r) => [r.agentId, r.state])).toEqual([
      ["a", "satisfied"],
      ["b", "missing"],
    ]);
  });

  it("not_run is never a pass: a current run that did not measure the class", () => {
    const [r] = run([agentA], [rt({ redteamClasses: [{ attackClass: "bias", probes: 3, defeated: 0 }] })]);
    expect(r!.state).toBe("not_run");
    // nor a class with zero measured probes
    const [z] = run([agentA], [rt({ redteamClasses: [{ attackClass: "prompt_injection", probes: 0, defeated: 0 }] })]);
    expect(z!.state).toBe("not_run");
  });

  it("a defeated probe past the threshold fails; the NEWEST current run decides", () => {
    const failing = rt({ runId: "run-2", completedAt: daysAgo(1), redteamClasses: [{ attackClass: "jailbreak", probes: 4, defeated: 1 }] });
    const [r] = run([agentA], [rt(), failing]);
    expect(r).toMatchObject({ state: "failing", runId: "run-2", value: 25 });
  });

  it("a use case with no agent in its stack is missing, never satisfied", () => {
    expect(run([], []).map((r) => [r.agentId, r.state])).toEqual([[null, "missing"]]);
  });
});

describe("ADR-0180 A3 deploy-gate composition", () => {
  const base = (over: Partial<DeployGateInput> = {}): DeployGateInput => ({
    useCase: { id: "u", name: "UC", status: "approved", intendedAgentIds: ["a"] },
    requestedAgentIds: null,
    agents: new Map([["a", { id: "a", name: "Agent A", halted: false, enabled: true, lifecycleStatus: "active", mrmRefusal: null, modelCardApproved: true }]]),
    alerts: [],
    conditionVerdicts: [],
    requiredTests: [{ testClass: PI, agentId: "a", state: "missing", runId: null, completedAt: null, value: null }],
    autonomy: null,
    residualRisks: [],
    ...over,
  });

  it("enforce holds on a missing required test, with its plain-language explanation", () => {
    const d = evaluateDeployGate(base({ assuranceMode: "enforce" }));
    expect(d.decision).toBe("deny");
    expect(d.reasons[0]).toMatchObject({ code: "required_test_missing", severity: "block", ref: { type: "agent", id: "a" } });
    expect(d.reasons[0]!.explanation).toMatch(/requires this OWASP test class/);
    expect(d.assurance).toEqual({ mode: "enforce", status: "enforced", label: "enforced (mode enforce)" });
  });

  it("warn lists it as a warning and does not hold", () => {
    const d = evaluateDeployGate(base({ assuranceMode: "warn" }));
    expect(d.decision).toBe("allow");
    expect(d.reasons.map((r) => [r.code, r.severity])).toEqual([["required_test_missing", "warn"]]);
  });

  it("off skips the checks and says so", () => {
    const d = evaluateDeployGate(base({ assuranceMode: "off" }));
    expect(d.decision).toBe("allow");
    expect(d.reasons).toEqual([]);
    expect(d.assurance).toEqual({ mode: "off", status: "skipped", label: "skipped (mode off)" });
  });

  it("stale and failing map to their own codes; a satisfied test adds nothing", () => {
    const d = evaluateDeployGate(
      base({
        assuranceMode: "enforce",
        requiredTests: [
          { testClass: PI, agentId: "a", state: "satisfied", runId: "r", completedAt: null, value: 0 },
          { testClass: "owasp:llm:02", agentId: "a", state: "stale", runId: "r", completedAt: null, value: 0 },
          { testClass: "owasp:llm:06", agentId: "a", state: "failing", runId: "r", completedAt: null, value: 50 },
          { testClass: "owasp:agentic:asi01", agentId: "a", state: "not_run", runId: "r", completedAt: null, value: null },
        ],
      }),
    );
    expect(d.reasons.map((r) => r.code).sort()).toEqual(["required_test_failing", "required_test_missing", "required_test_stale"]);
  });

  it("a check that was not gathered is reported, never passed", () => {
    const { requiredTests: _omitted, ...rest } = base({ assuranceMode: "enforce" });
    const d = evaluateDeployGate(rest);
    expect(d.decision).toBe("deny");
    expect(d.reasons.map((r) => r.code)).toEqual(["assurance_check_unavailable"]);
    // fail closed under enforce, a labelled warning under warn — never a silent pass
    const { residualRisks: _r, autonomy: _a, ...partial } = base({ assuranceMode: "warn", requiredTests: [] });
    const w = evaluateDeployGate(partial);
    expect(w.decision).toBe("allow");
    expect(w.reasons.map((r) => [r.code, r.severity])).toEqual([
      ["assurance_check_unavailable", "warn"],
      ["assurance_check_unavailable", "warn"],
    ]);
  });

  it("composes the other owners' results: failing and waived conditions, unmet floors, residual above tolerance", () => {
    const verdict = (id: string, state: "fail" | "waived" | "insufficient" | "pass", status: "open" | "met" | "waived" = "open") => ({
      conditionId: id, useCaseId: "u", kind: "metric" as const, text: `cond ${id}`, blocking: true, status, state,
      measurement: null, onBreach: "alert" as const, consecutiveBreaches: 0, evaluatedAt: null,
    });
    const d = evaluateDeployGate(
      base({
        assuranceMode: "enforce",
        requiredTests: [],
        conditionVerdicts: [verdict("c1", "fail"), verdict("c2", "waived", "waived"), verdict("c3", "insufficient"), verdict("c4", "pass", "met")],
        autonomy: {
          facts: { schedules: 1, subAgents: 0, writeToolsWithoutAskFirst: 0, inboundChannels: 0, computerUse: false },
          derived: "autonomous", declared: null,
          unmet: [{ kind: "manual", text: "kill switch tested", dueAt: "2026-12-01", blocking: true }],
        },
        residualRisks: [
          { riskId: "r1", band: "high", tolerance: { band: "medium", source: "default" }, acceptance: null, aboveTolerance: true },
          { riskId: "r2", band: "high", tolerance: { band: "medium", source: "default" }, aboveTolerance: true,
            acceptance: { id: "x", responseType: "accept", residualBand: "high", acceptedByUserId: null, acceptedAt: "", expiresAt: "" } },
        ],
      }),
    );
    expect(d.reasons.map((r) => [r.code, r.severity, r.ref?.id])).toEqual([
      ["autonomy_floor_unmet", "block", "u"],
      ["condition_failing", "block", "c1"],
      ["condition_not_measured", "block", "c3"],
      ["residual_above_tolerance", "block", "r1"],
      ["condition_waived", "warn", "c2"],
    ]);
  });
});
