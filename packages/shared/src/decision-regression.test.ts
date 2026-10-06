/**
 * ADR-0182 (ADR-0175 batch D4) A11 — THE CI GOLDEN TEST.
 *
 * The shipped golden set runs against the code defaults on every CI run. A
 * change to the screening rules, the suggestion rules or the required-test
 * defaults that alters any case's outcome fails HERE until
 * `decision-regression/golden-expected.ts` is updated in the same commit (and
 * `INTAKE_ASSIST_RULES_VERSION` with it, for a suggestion-rule change). The
 * failure prints the case's new outcome, so the update is a reviewed copy,
 * not a guess.
 */
import { describe, expect, it } from "vitest";
import {
  DECISION_OUTCOME_FIELDS,
  DECISION_REGRESSION_CODE_DEFAULTS,
  DEFAULT_INTAKE_SIGNOFF_APPROVERS,
  GOLDEN_EXPECTED,
  GOLDEN_EXPECTED_VERSIONS,
  SHIPPED_GOLDEN_CASES,
  decisionOutcomeFor,
  decisionRegressionCandidate,
  decisionRuleVersions,
  diffDecisionOutcomes,
  intakeTemplateDigest,
  isIntakeTemplateName,
  reviewPolicyBodyDigest,
  runDecisionRegression,
  shippedDecisionRegressionCases,
  type DecisionRegressionConfig,
} from "./decision-regression.js";
import { EU_AI_ACT_TIERS } from "./eu-ai-act.js";
import { INTAKE_ASSIST_RULES_VERSION } from "./intake-assist.js";

const ROLE_A = "11111111-1111-4111-8111-111111111111";
const ROLE_B = "22222222-2222-4222-8222-222222222222";

describe("the shipped golden set under the code defaults", () => {
  it("every case produces exactly its expected outcome", () => {
    const run = runDecisionRegression(shippedDecisionRegressionCases(), DECISION_REGRESSION_CODE_DEFAULTS);
    const drift = run.expectedDiff.entries.map(
      (e) => `${e.caseId} changed ${e.changed.join(", ")} — new outcome:\n${JSON.stringify(e.after, null, 2)}`,
    );
    expect(drift, `update decision-regression/golden-expected.ts in this commit if the change is intended:\n${drift.join("\n")}`).toEqual([]);
    expect(run.expectedDiff.changed).toBe(0);
    expect(run.results).toHaveLength(SHIPPED_GOLDEN_CASES.length);
  });

  it("each shipped case has a complete expectation, and no expectation is orphaned", () => {
    const ids = SHIPPED_GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(GOLDEN_EXPECTED).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(Object.keys(GOLDEN_EXPECTED[id]!).sort()).toEqual([...DECISION_OUTCOME_FIELDS].sort());
  });

  it("the expectations name the rule versions they were produced under", () => {
    expect(GOLDEN_EXPECTED_VERSIONS).toEqual(decisionRuleVersions());
    expect(GOLDEN_EXPECTED_VERSIONS.intakeAssistVersion).toBe(INTAKE_ASSIST_RULES_VERSION);
  });

  it("reaches every screening tier, the unscreened route, and both 'Not sure' rules (ADR-0171)", () => {
    const tiers = new Set(Object.values(GOLDEN_EXPECTED).map((o) => o.tier));
    for (const t of EU_AI_ACT_TIERS) expect(tiers.has(t), t).toBe(true);
    expect(tiers.has(null)).toBe(true);
    const reasons = Object.values(GOLDEN_EXPECTED).flatMap((o) => o.reasons);
    expect(reasons.some((r) => r.startsWith("not sure: "))).toBe(true);
    expect(reasons.some((r) => r.includes("unsure_answer_must_count_as_yes"))).toBe(true);
    // the Art. 6(3) derogation: an Annex III domain that stays minimal
    expect(GOLDEN_EXPECTED["minimal-hr-narrow-procedural"]!.tier).toBe("minimal");
  });

  it("is pure: the same cases and configuration give the same result", () => {
    const a = runDecisionRegression(shippedDecisionRegressionCases(), DECISION_REGRESSION_CODE_DEFAULTS);
    const b = runDecisionRegression(shippedDecisionRegressionCases(), DECISION_REGRESSION_CODE_DEFAULTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("an unscreened case is routed as the unscreened tier (strict tests, the template's approver)", () => {
    const o = GOLDEN_EXPECTED["unscreened-missing-answer"]!;
    expect(o.tier).toBeNull();
    expect(o.requiredTests).toEqual(GOLDEN_EXPECTED["high-credit-scoring"]!.requiredTests);
    expect(o.approverRouting).toBe(`single approver: ${DEFAULT_INTAKE_SIGNOFF_APPROVERS.join(", ")}`);
  });
});

describe("a configuration change against a baseline", () => {
  const routedHigh: DecisionRegressionConfig = {
    ...DECISION_REGRESSION_CODE_DEFAULTS,
    reviewPolicy: {
      roles: [
        { id: "privacy", name: "Privacy", memberUserIds: [ROLE_A] },
        { id: "model-risk", name: "Model risk", memberUserIds: [ROLE_B] },
      ],
      tiers: { high: { roleIds: ["privacy", "model-risk"] } },
      riskAcceptorUserIds: [],
    },
  };

  it("routing the high tier to roles changes exactly the high cases' roles and routing", () => {
    const run = runDecisionRegression(shippedDecisionRegressionCases(), routedHigh, { baseline: DECISION_REGRESSION_CODE_DEFAULTS });
    const high = Object.entries(GOLDEN_EXPECTED).filter(([, o]) => o.tier === "high").map(([id]) => id).sort();
    expect(run.baselineDiff!.entries.map((e) => e.caseId).sort()).toEqual(high);
    for (const e of run.baselineDiff!.entries) {
      expect(e.changed).toEqual(["requiredRoles", "approverRouting"]);
      expect(e.after.requiredRoles).toEqual(["privacy", "model-risk"]);
      expect(e.after.approverRouting).toBe("review roles: privacy, model-risk");
    }
    // the expectations are about the code defaults, so they now differ too
    expect(run.expectedDiff.changed).toBe(high.length);
  });

  it("a configuration identical to the baseline changes nothing", () => {
    const run = runDecisionRegression(shippedDecisionRegressionCases(), routedHigh, { baseline: routedHigh });
    expect(run.baselineDiff).toEqual({ cases: SHIPPED_GOLDEN_CASES.length, changed: 0, entries: [] });
  });

  it("relaxing a tier's required tests changes that tier's cases", () => {
    const relaxed: DecisionRegressionConfig = { ...DECISION_REGRESSION_CODE_DEFAULTS, requiredTests: { minimal: { classes: [], freshnessDays: 30 } } };
    const run = runDecisionRegression(shippedDecisionRegressionCases(), relaxed, { baseline: DECISION_REGRESSION_CODE_DEFAULTS });
    const minimal = Object.entries(GOLDEN_EXPECTED).filter(([, o]) => o.tier === "minimal").map(([id]) => id).sort();
    expect(run.baselineDiff!.entries.map((e) => e.caseId).sort()).toEqual(minimal);
    for (const e of run.baselineDiff!.entries) {
      expect(e.changed).toEqual(["requiredTests"]);
      expect(e.after.requiredTests).toEqual([]);
    }
  });

  it("a template that names an approver changes the routing of every case without review roles", () => {
    const t: DecisionRegressionConfig = {
      ...DECISION_REGRESSION_CODE_DEFAULTS,
      template: { name: "ai-use-case-intake/owner", definition: { stages: [{ id: "signoff", type: "human_approval", approvers: [ROLE_A] }] } },
    };
    const run = runDecisionRegression(shippedDecisionRegressionCases(), t, { baseline: DECISION_REGRESSION_CODE_DEFAULTS });
    expect(run.baselineDiff!.changed).toBe(SHIPPED_GOLDEN_CASES.length);
    for (const e of run.baselineDiff!.entries) expect(e.after.approverRouting).toBe(`single approver: ${ROLE_A}`);
  });

  it("an override case compares only the fields it pins", () => {
    const answers = SHIPPED_GOLDEN_CASES.find((c) => c.id === "high-credit-scoring")!.answers;
    const pinTier = runDecisionRegression([{ id: "o1", label: "override", source: "override", answers, expected: { tier: "high" } }], routedHigh);
    expect(pinTier.expectedDiff.changed).toBe(0);
    const wrong = runDecisionRegression([{ id: "o2", label: "override", source: "override", answers, expected: { tier: "limited" } }], routedHigh);
    expect(wrong.expectedDiff.entries[0]!.changed).toEqual(["tier"]);
    expect(wrong.results[0]!.unmetExpectation).toEqual(["tier"]);
  });

  it("diffs field by field in the outcome's order", () => {
    const o = decisionOutcomeFor(SHIPPED_GOLDEN_CASES[0]!.answers, DECISION_REGRESSION_CODE_DEFAULTS);
    expect(diffDecisionOutcomes(o, { ...o, approverRouting: "x", tier: "high" })).toEqual(["tier", "approverRouting"]);
  });
});

describe("candidate digests", () => {
  const policy = {
    roles: [{ id: "privacy", name: "Privacy", memberUserIds: [ROLE_A] }],
    tiers: { high: { roleIds: ["privacy"] } },
    riskAcceptorUserIds: [],
  };

  it("a review policy body and its write (with acceptance fields and echoes) have one digest", () => {
    const a = decisionRegressionCandidate("review_policy", policy);
    const b = decisionRegressionCandidate("review_policy", {
      ...policy,
      updatedAt: "2026-10-06T00:00:00Z",
      updatedByName: "Ada",
      version: 4,
      regressionRunId: "33333333-3333-4333-8333-333333333333",
      acceptChangedOutcomes: true,
      acceptReason: "routing the high tier to privacy",
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.digest).toBe(b.digest);
    if (a.ok) expect(a.digest).toBe(reviewPolicyBodyDigest(a.normalized as never));
  });

  it("a different body has a different digest", () => {
    const a = decisionRegressionCandidate("review_policy", policy);
    const b = decisionRegressionCandidate("review_policy", { ...policy, tiers: { high: { roleIds: [] } } });
    if (!a.ok || !b.ok) throw new Error("parse");
    expect(a.digest).not.toBe(b.digest);
  });

  it("required tests digest the parsed body (a defaulted freshness is the same body)", () => {
    const a = decisionRegressionCandidate("required_tests", { high: { classes: [] } });
    const b = decisionRegressionCandidate("required_tests", { high: { classes: [], freshnessDays: 30 } });
    if (!a.ok || !b.ok) throw new Error("parse");
    expect(a.digest).toBe(b.digest);
  });

  it("an invalid candidate is refused with the schema's issues", () => {
    const r = decisionRegressionCandidate("review_policy", { roles: "nope" });
    expect(r.ok).toBe(false);
    expect(decisionRegressionCandidate("intake_template", { name: "x" }).ok).toBe(false);
  });

  it("D4G-12: an intake candidate is digested once resolved; the digest is over the name and the definition only", () => {
    const parsed = decisionRegressionCandidate("intake_template", { galleryId: "ai-use-case-intake", name: "ai-use-case-intake/x" });
    expect(parsed).toMatchObject({ ok: true, digest: null });
    expect(decisionRegressionCandidate("intake_template", { retireTemplateId: "00000000-0000-4000-8000-000000000001" }).ok).toBe(true);
    expect(decisionRegressionCandidate("intake_template", { retireTemplateId: "nope" }).ok).toBe(false);
    const def = { stages: [{ id: "signoff", type: "human_approval", approvers: ["requesting_user"] }] };
    const a = intakeTemplateDigest({ name: "ai-use-case-intake/x", definition: def });
    expect(intakeTemplateDigest({ name: "ai-use-case-intake/x", definition: JSON.parse(JSON.stringify(def)) })).toBe(a);
    expect(intakeTemplateDigest({ name: "ai-use-case-intake/y", definition: def })).not.toBe(a);
    expect(intakeTemplateDigest({ name: "ai-use-case-intake/x", definition: { stages: [{ ...def.stages[0]!, approvers: ["u-1"] }] } })).not.toBe(a);
    expect(intakeTemplateDigest(null)).not.toBe(a);
  });

  it("names the intake template and its variants, and nothing else", () => {
    expect(isIntakeTemplateName("ai-use-case-intake")).toBe(true);
    expect(isIntakeTemplateName("ai-use-case-intake/governance-owner")).toBe(true);
    expect(isIntakeTemplateName("ai-use-case-intake-copy")).toBe(false);
    expect(isIntakeTemplateName("standard-change")).toBe(false);
  });
});
