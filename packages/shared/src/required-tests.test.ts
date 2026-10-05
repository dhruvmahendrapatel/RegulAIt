/**
 * ADR-0180 A3 — required AI test classes per risk tier (the pure half), and
 * the deploy gate's composition of the continuous-assurance checks.
 *
 * Each rule has a test that fails without it:
 *   - an unmeasurable OWASP id is refused;
 *   - a stale run fails; a config-hash mismatch fails; one agent missing a run
 *     fails; `not_run` is never a pass;
 *   - enforce holds, warn does not, off is labelled skipped;
 *   - the strict defaults apply when the stored policy is empty;
 *   - the evidence bar (FA3): a single-trial run, a run that missed a mapped
 *     attack class, or one with too few reached trials is not evidence, and a
 *     newer, thinner run never masks an older failing one; an eval run needs
 *     enough results of every mapped scorer;
 *   - the gate passes ONLY `satisfied` (an unknown state holds).
 */
import { describe, expect, it } from "vitest";
import { OWASP_AGENTIC_TOP_10_MAPPING, OWASP_LLM_TOP_10_MAPPING } from "./owasp-framework-mappings.js";
import {
  DEFAULT_REQUIRED_MAX_ASR_PCT,
  REQUIRED_TEST_DEFAULTS,
  REQUIRED_TEST_EVIDENCE_BAR,
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
/** every red-team class the catalog maps to LLM01, each reached by 1 probe x 3 trials */
const LLM01_CLASSES = ["prompt_injection", "jailbreak", "indirect_prompt_injection", "encoding_evasion"];
const covering = (over: Record<string, Partial<{ probes: number; trials: number; defeated: number }>> = {}) =>
  LLM01_CLASSES.map((attackClass) => ({ attackClass, probes: 1, trials: 3, defeated: 0, ...over[attackClass] }));
const rt = (over: Partial<RequiredTestRunEvidence> = {}): RequiredTestRunEvidence => ({
  kind: "redteam",
  runId: "run-1",
  agentId: "a",
  configHash: "h-a",
  completedAt: daysAgo(2),
  trialsPerProbe: 3,
  measurementQuality: "low-power",
  redteamClasses: covering(),
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
    const [r] = run([agentA], [rt({ redteamClasses: [{ attackClass: "bias", probes: 3, trials: 9, defeated: 0 }] })]);
    expect(r!.state).toBe("not_run");
    // nor a class with zero measured probes
    const [z] = run([agentA], [rt({ redteamClasses: [{ attackClass: "prompt_injection", probes: 0, trials: 0, defeated: 0 }] })]);
    expect(z!.state).toBe("not_run");
  });

  it("a defeated probe past the threshold fails; the NEWEST current run decides", () => {
    const failing = rt({ runId: "run-2", completedAt: daysAgo(1), redteamClasses: covering({ jailbreak: { probes: 4, trials: 12, defeated: 1 } }) });
    const [r] = run([agentA], [rt(), failing]);
    expect(r).toMatchObject({ state: "failing", runId: "run-2", value: 14.29 });
  });

  // ---- FA3: the evidence bar -------------------------------------------------
  it("a single-trial run is not evidence (smoke test, not a measurement)", () => {
    const [r] = run([agentA], [rt({ trialsPerProbe: 1, measurementQuality: "single-trial" })]);
    expect(r).toMatchObject({ state: "not_run" });
    expect(r!.detail).toMatch(/single-trial at 1 trial/);
    // the label is an allow-list: an unlabelled run never counts, whatever its N
    expect(run([agentA], [rt({ measurementQuality: null })])[0]!.state).toBe("not_run");
    expect(run([agentA], [rt({ trialsPerProbe: REQUIRED_TEST_EVIDENCE_BAR.minTrialsPerProbe - 1 })])[0]!.state).toBe("not_run");
  });

  it("a run that skipped one attack class mapped to the id is not evidence (1 probe in 1 class is not LLM01)", () => {
    const thin = rt({ redteamClasses: [{ attackClass: "prompt_injection", probes: 1, trials: 3, defeated: 0 }] });
    const [r] = run([agentA], [thin]);
    expect(r!.state).toBe("not_run");
    expect(r!.detail).toMatch(/short on jailbreak .*indirect_prompt_injection .*encoding_evasion/);
    const noEncoding = rt({ redteamClasses: covering().filter((c) => c.attackClass !== "encoding_evasion") });
    expect(run([agentA], [noEncoding])[0]!.state).toBe("not_run");
  });

  it("a class with too few REACHED trials is not evidence (platform-held and errored trials are not counted upstream)", () => {
    const [r] = run([agentA], [rt({ redteamClasses: covering({ encoding_evasion: { trials: REQUIRED_TEST_EVIDENCE_BAR.minTrialsPerClass - 1 } }) })]);
    expect(r!.state).toBe("not_run");
    expect(r!.detail).toMatch(/encoding_evasion \(1 probe\(s\), 2 trial\(s\)\)/);
  });

  it("the newest COVERING run decides: a newer, thinner run cannot mask an older failing one", () => {
    const olderFailing = rt({ runId: "run-old", completedAt: daysAgo(5), redteamClasses: covering({ jailbreak: { defeated: 1 } }) });
    const newerThin = rt({ runId: "run-new", completedAt: daysAgo(1), redteamClasses: [{ attackClass: "prompt_injection", probes: 1, trials: 3, defeated: 0 }] });
    const [r] = run([agentA], [newerThin, olderFailing]);
    expect(r).toMatchObject({ state: "failing", runId: "run-old" });
    // and a newer single-trial pass does not mask it either
    const newerSmoke = rt({ runId: "run-smoke", completedAt: daysAgo(1), trialsPerProbe: 1, measurementQuality: "single-trial" });
    expect(run([agentA], [newerSmoke, olderFailing])[0]).toMatchObject({ state: "failing", runId: "run-old" });
  });

  it("an eval run needs enough results of EVERY scorer mapped to the id", () => {
    const misinformation = { classes: [{ testClass: "owasp:llm:09", minScore: 0.8 }], freshnessDays: 30 };
    const ev = (scorers: Array<{ scorerKind: string; results: number; meanScore: number }>): RequiredTestRunEvidence => ({
      kind: "eval", runId: "ev-1", agentId: "a", configHash: "h-a", completedAt: daysAgo(1), scorers,
    });
    const evalOf = (runs: RequiredTestRunEvidence[]) => evaluateRequiredTests({ tierPolicy: misinformation, agents: [agentA], runs, now: NOW })[0]!;
    const n = REQUIRED_TEST_EVIDENCE_BAR.minResultsPerScorer;
    expect(evalOf([ev([{ scorerKind: "claim_support", results: 1, meanScore: 1 }])]).state).toBe("not_run");
    expect(evalOf([ev([{ scorerKind: "claim_support", results: n, meanScore: 1 }])]).state).toBe("not_run");
    expect(
      evalOf([ev([{ scorerKind: "claim_support", results: n, meanScore: 1 }, { scorerKind: "groundedness_judge", results: n, meanScore: 0.9 }])]).state,
    ).toBe("satisfied");
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

  it("only `satisfied` passes: a state this build does not know holds as missing (allow-list, fail closed)", () => {
    for (const state of ["pass", "insufficient", "waived", "", undefined]) {
      const d = evaluateDeployGate(
        base({
          assuranceMode: "enforce",
          requiredTests: [{ testClass: PI, agentId: "a", state: state as never, runId: "r", completedAt: null, value: 0 }],
        }),
      );
      expect(d.decision, String(state)).toBe("deny");
      expect(d.reasons.map((r) => [r.code, r.severity])).toEqual([["required_test_missing", "block"]]);
    }
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
