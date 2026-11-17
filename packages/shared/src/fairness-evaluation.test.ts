/**
 * ADR-0346 — fairness evaluation's pure half: the template, the strict reply mapping, the definition checks, the
 * relaxation facts and the promotion gate's verdict.
 */
import { describe, expect, it } from "vitest";
import { FAIRNESS_DEFAULT_THRESHOLDS } from "./fairness.js";
import {
  FAIRNESS_EVALUATION_DEFAULT_SETTINGS,
  acceptFairnessBreachSchema,
  breachAcceptanceInForce,
  createFairnessEvaluationSchema,
  createModelInputDatasetSchema,
  effectiveEvaluationThresholds,
  evaluateFairnessGate,
  evaluationDefinitionProblems,
  fairnessEvaluationRelaxed,
  fairnessGateApplies,
  fairnessOutcomeIsBreach,
  fillPromptTemplate,
  mapFairnessReply,
  parsePromptTemplate,
  templateColumns,
  unparseableOverCap,
  FAIRNESS_BREACH_REVIEW_STATUSES,
  FAIRNESS_BREACH_REVIEW_TRANSITIONS,
  FAIRNESS_EVALUATION_TRANSITIONS,
  lifecycleAllows,
  type GateCandidateRun,
} from "./fairness-evaluation.js";

const CARD = "00000000-0000-4000-8000-000000000001";
const DS = "00000000-0000-4000-8000-000000000002";
const base = {
  cardId: CARD,
  datasetId: DS,
  name: "loan decisions",
  attributes: ["sex"],
  promptTemplate: "Applicant: {{ summary }}. Answer approve or decline.",
  favourableOutput: "approve",
  unfavourableOutput: "decline",
};

describe("the prompt template", () => {
  it("splits text and placeholders, trimming names", () => {
    expect(parsePromptTemplate("a {{ x }} b {{y}}")).toEqual([
      { kind: "text", text: "a " },
      { kind: "column", name: "x" },
      { kind: "text", text: " b " },
      { kind: "column", name: "y" },
    ]);
    expect(templateColumns("{{x}}{{y}}{{x}}")).toEqual(["x", "y"]);
    expect(templateColumns("no placeholders")).toEqual([]);
  });
  it("refuses malformed templates", () => {
    expect(parsePromptTemplate("a {{ x")).toBeNull();
    expect(parsePromptTemplate("{{   }}")).toBeNull();
    expect(parsePromptTemplate("{{ a{b }}")).toBeNull();
    expect(parsePromptTemplate(`{{${"x".repeat(201)}}}`)).toBeNull();
  });
  it("fills from a row and refuses a missing column", () => {
    const parts = parsePromptTemplate("Hi {{name}}!")!;
    expect(fillPromptTemplate(parts, { name: "Sam" })).toBe("Hi Sam!");
    expect(() => fillPromptTemplate(parts, {})).toThrow(/name/);
  });
});

describe("the reply mapping is exact after trim and case-fold", () => {
  const outputs = { favourable: "Approve", unfavourable: "decline" };
  it("maps the two declared outputs", () => {
    expect(mapFairnessReply("  APPROVE \n", outputs)).toBe(1);
    expect(mapFairnessReply("Decline", outputs)).toBe(0);
  });
  it("never guesses", () => {
    expect(mapFairnessReply("I would approve", outputs)).toBeNull();
    expect(mapFairnessReply("approve.", outputs)).toBeNull();
    expect(mapFairnessReply("", outputs)).toBeNull();
  });
  it("caps unparseable replies (strict 0)", () => {
    expect(unparseableOverCap(0, 100, 0)).toBe(false);
    expect(unparseableOverCap(1, 100, 0)).toBe(true);
    expect(unparseableOverCap(5, 100, 0.05)).toBe(false);
    expect(unparseableOverCap(6, 100, 0.05)).toBe(true);
    expect(unparseableOverCap(0, 0, 0.05)).toBe(true);
  });
});

describe("the schemas", () => {
  it("accepts a strict definition and stores the strict defaults", () => {
    const d = createFairnessEvaluationSchema.parse(base);
    expect(fairnessEvaluationRelaxed(d)).toEqual({});
    expect(effectiveEvaluationThresholds(d.thresholds)).toEqual(FAIRNESS_DEFAULT_THRESHOLDS.map((t) => ({ ...t })));
  });
  it("refuses equal outputs, a template without a column, duplicate attributes, a group size below 30 and a cap above 5%", () => {
    expect(createFairnessEvaluationSchema.safeParse({ ...base, unfavourableOutput: "APPROVE" }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, promptTemplate: "no columns" }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, attributes: ["sex", "sex"] }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, minGroupSize: 29 }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, maxUnparseableRate: 0.06 }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, intervalHours: 0 }).success).toBe(false);
    expect(createFairnessEvaluationSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("names every relaxation", () => {
    const r = fairnessEvaluationRelaxed({
      thresholds: [{ metric: "demographic_parity_difference", limit: 0.2, action: "fail" }],
      minGroupSize: 50,
      maxUnparseableRate: 0.01,
    });
    expect(r).toMatchObject({
      "fairnessRun.demographic_parity_difference": { limit: 0.2, action: "fail" },
      "fairnessRun.disparate_impact_ratio": "omitted",
      "fairnessRun.minGroupSize": 50,
      "fairnessEvaluation.maxUnparseableRate": 0.01,
    });
  });
  it("model-input datasets need distinct columns and a card", () => {
    const ds = {
      kind: "model_inputs" as const,
      name: "d",
      csv: "a,b,c\n",
      labelColumn: "label",
      favourableLabel: "1",
      protectedAttributes: ["sex"],
      inputColumns: ["summary"],
      cardId: CARD,
    };
    expect(createModelInputDatasetSchema.safeParse(ds).success).toBe(true);
    expect(createModelInputDatasetSchema.safeParse({ ...ds, inputColumns: ["sex"] }).success).toBe(false);
    expect(createModelInputDatasetSchema.safeParse({ ...ds, cardId: undefined }).success).toBe(false);
    expect(createModelInputDatasetSchema.safeParse({ ...ds, inputColumns: Array.from({ length: 9 }, (_, i) => `c${i}`) }).success).toBe(false);
  });
  it("checks a definition against its dataset, naming columns only", () => {
    const facts = { kind: "model_inputs" as const, protectedAttributes: ["sex"], inputColumns: ["summary"], purged: false };
    expect(evaluationDefinitionProblems(base, facts)).toEqual([]);
    expect(evaluationDefinitionProblems({ ...base, attributes: ["age"], promptTemplate: "{{other}}" }, facts)).toEqual([
      "attribute_not_in_dataset:age",
      "template_column_not_input:other",
    ]);
    expect(evaluationDefinitionProblems(base, { ...facts, kind: "supplied_predictions", purged: true })).toEqual([
      "dataset_not_model_inputs",
      "dataset_purged",
    ]);
  });
  it("a breach acceptance needs a reason and lasts at most 90 days", () => {
    expect(acceptFairnessBreachSchema.safeParse({ reason: "documented business need", days: 90 }).success).toBe(true);
    expect(acceptFairnessBreachSchema.safeParse({ reason: "documented business need", days: 91 }).success).toBe(false);
    expect(acceptFairnessBreachSchema.safeParse({ reason: "short", days: 10 }).success).toBe(false);
  });
});

describe("breaches and the promotion gate", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const day = 86_400_000;
  const run = (o: Partial<GateCandidateRun> = {}): GateCandidateRun => ({
    outcome: "pass",
    createdAt: new Date(now.getTime() - day),
    cardModelVersion: "v1",
    review: null,
    ...o,
  });
  const gate = (latest: GateCandidateRun | null, extra: Partial<Parameters<typeof evaluateFairnessGate>[0]> = {}) =>
    evaluateFairnessGate({ applies: true, latest, cardModelVersion: "v1", maxAgeDays: 90, now, ...extra });

  it("is opt-in per tenant and forced by a compliance tag", () => {
    expect(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessPromotionGate).toBe(false);
    expect(fairnessGateApplies(false, [null, false])).toEqual({ applies: false, source: null });
    expect(fairnessGateApplies(false, [null, true])).toEqual({ applies: true, source: "compliance_tag" });
    expect(fairnessGateApplies(true, [])).toEqual({ applies: true, source: "org" });
  });
  it("inconclusive is never a breach to accept", () => {
    expect(fairnessOutcomeIsBreach("fail")).toBe(true);
    expect(fairnessOutcomeIsBreach("flag")).toBe(true);
    expect(fairnessOutcomeIsBreach("inconclusive")).toBe(false);
    expect(fairnessOutcomeIsBreach("pass")).toBe(false);
  });
  it("allows only a fresh passing run on the current version, or an accepted breach in force", () => {
    expect(evaluateFairnessGate({ applies: false, latest: null, cardModelVersion: null, maxAgeDays: 90, now })).toEqual({
      allowed: true,
      reason: "gate_not_applied",
    });
    expect(gate(null)).toEqual({ allowed: false, reason: "no_run" });
    expect(gate(run())).toEqual({ allowed: true, reason: "passing_run" });
    expect(gate(run({ cardModelVersion: "v0" }))).toEqual({ allowed: false, reason: "stale_version" });
    expect(gate(run({ createdAt: new Date(now.getTime() - 91 * day) }))).toEqual({ allowed: false, reason: "too_old" });
    expect(gate(run({ outcome: "inconclusive" }))).toEqual({ allowed: false, reason: "inconclusive" });
    expect(gate(run({ outcome: "fail" }))).toEqual({ allowed: false, reason: "breach_not_accepted" });
    const accepted = { status: "accepted" as const, acceptedUntil: new Date(now.getTime() + day) };
    expect(gate(run({ outcome: "fail", review: accepted }))).toEqual({ allowed: true, reason: "breach_accepted" });
    const lapsed = { status: "accepted" as const, acceptedUntil: new Date(now.getTime() - 1) };
    expect(gate(run({ outcome: "flag", review: lapsed }))).toEqual({ allowed: false, reason: "breach_not_accepted" });
    expect(breachAcceptanceInForce({ status: "rejected", acceptedUntil: null }, now)).toBe(false);
  });
});

describe("the declared lifecycles (rule 12)", () => {
  it("a breach review starts pending, is decided once, and only supersession follows an acceptance", () => {
    const T = FAIRNESS_BREACH_REVIEW_TRANSITIONS;
    expect(Object.keys(T).sort()).toEqual([...FAIRNESS_BREACH_REVIEW_STATUSES].sort());
    expect(lifecycleAllows(T, "pending", "accepted")).toBe(true);
    expect(lifecycleAllows(T, "pending", "rejected")).toBe(true);
    expect(lifecycleAllows(T, "accepted", "superseded")).toBe(true);
    expect(lifecycleAllows(T, "accepted", "rejected")).toBe(false);
    expect(lifecycleAllows(T, "rejected", "accepted")).toBe(false);
    expect(lifecycleAllows(T, "superseded", "pending")).toBe(false);
    expect(lifecycleAllows(T, "pending", "pending")).toBe(false);
  });
  it("archiving an evaluation is final", () => {
    expect(lifecycleAllows(FAIRNESS_EVALUATION_TRANSITIONS, "active", "archived")).toBe(true);
    expect(lifecycleAllows(FAIRNESS_EVALUATION_TRANSITIONS, "archived", "active")).toBe(false);
  });
});
