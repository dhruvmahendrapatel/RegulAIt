/**
 * ADR-0182 (ADR-0175 batch D4) A11 — DECISION REGRESSION: the golden set
 * runner and the result diff (the pure half). OWNER: A11 (D4).
 *
 * NIST AI RMF MEASURE 1.2 / MEASURE 2.13 / GOVERN 1.4: a decision must be
 * reproducible, and a change to what produces decisions must show, before it
 * is live, which decisions it would change. This file answers "what would
 * this configuration decide for this set of answers?" with no I/O:
 *
 *   outcome = screening tier and the rules that fired (ADR-0085 classifier),
 *             suggested frameworks and controls (ADR-0149 suggestion rules),
 *             required review roles (review policy), required AI tests
 *             (required-tests policy, strict defaults for a tier left out),
 *             and who signs off (review roles, else the intake template's
 *             single approver).
 *
 * `runDecisionRegression(cases, config, {baseline})` returns every case's
 * outcome, the cases whose outcome differs from its expectation, and (with a
 * baseline) the cases whose outcome the change ALTERS — the number the
 * activation gate makes an admin accept with a reason.
 *
 * The digests (`decisionRegressionCandidate`) are SHA-256 of the ADR-0060
 * canonical JSON of the NORMALISED body (parsed by the same schema the write
 * parses with, read-only echoes and acceptance fields dropped), so a preview
 * and the write of the same body agree byte for byte.
 *
 * OPEN SOURCE FIRST (ADR-0176): the outcome diff is structural — flat records
 * compared field by field in a fixed order. Considered `jsondiffpatch` (MIT)
 * and `microdiff` (MIT); none fits a need here, because the comparison is a
 * per-field equality over canonical JSON and the order is fixed by
 * `DecisionOutcome`'s keys (the compliance-pack-diff precedent). The text diff
 * of changed reasons uses `diff` (BSD-3) in the gateway.
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import {
  accountabilityDigest,
  type DecisionOutcome,
  type DecisionOutcomeField,
  type DecisionRegressionSubject,
  type RegressionCaseDiff,
  type RegressionDiff,
} from "./accountability.js";
import { canonicalJson } from "./audit-chain.js";
import { classifyEuAiActTier, EU_AI_ACT_RULESET_VERSION, unsureAnswerViolations, type EuAiActAnswers } from "./eu-ai-act.js";
import {
  INTAKE_ASSIST_RULES_VERSION,
  INTAKE_BOOLEAN_QUESTION_KEYS,
  intakeScreeningAnswersSchema,
  suggestIntake,
} from "./intake-assist.js";
import { effectiveRequiredTests, requiredTestPolicySchema, requiredTestThresholds } from "./required-tests.js";
import type { RequiredTestPolicy } from "./assurance.js";
import {
  REVIEW_POLICY_TIER_KEYS,
  reviewPolicyInputSchema,
  reviewPolicyStoredBody,
  type ReviewPolicyStoredBody,
  type ReviewPolicyTierKey,
} from "./review-policy.js";
import { SHIPPED_GOLDEN_CASES, type GoldenCase } from "./decision-regression/golden-cases.js";
import { GOLDEN_EXPECTED, GOLDEN_EXPECTED_VERSIONS } from "./decision-regression/golden-expected.js";

export { SHIPPED_GOLDEN_CASES, GOLDEN_EXPECTED, GOLDEN_EXPECTED_VERSIONS, type GoldenCase };
// the package barrel names review-policy.ts's exports one by one (index.ts is
// P0's); the A11 normalisation reaches the gateway through this file instead
export { reviewPolicyStoredBody, type ReviewPolicyStoredBody };
// likewise the suggestion-rules version (intake-assist.ts is named one by one there)
export { INTAKE_ASSIST_RULES_VERSION };

/** the outcome fields, in the order every diff lists them */
export const DECISION_OUTCOME_FIELDS: readonly DecisionOutcomeField[] = [
  "tier",
  "reasons",
  "frameworks",
  "requiredRoles",
  "requiredTests",
  "suggestedControls",
  "approverRouting",
];

/** the built-in intake shape's sign-off approver (gateway template-gallery.ts
 * `aiUseCaseIntakeDefinition`; a gateway test pins that the two agree) */
export const DEFAULT_INTAKE_SIGNOFF_APPROVERS: readonly string[] = Object.freeze(["requesting_user"]);

/** a workflow definition, as far as the regression reads it */
export interface DecisionRegressionTemplate {
  name: string;
  definition: { stages: ReadonlyArray<{ id: string; type: string; approvers?: readonly string[] }> };
}

/** everything that produces an intake decision, besides the code itself */
export interface DecisionRegressionConfig {
  /** null = no policy row: every tier keeps the template's single approver */
  reviewPolicy: ReviewPolicyStoredBody | null;
  /** null or `{}` = every tier at its strict default */
  requiredTests: RequiredTestPolicy | null;
  /** null = the built-in intake shape */
  template: DecisionRegressionTemplate | null;
}

/** the code defaults: no review policy, strict required tests, built-in template */
export const DECISION_REGRESSION_CODE_DEFAULTS: Readonly<DecisionRegressionConfig> = Object.freeze({
  reviewPolicy: null,
  requiredTests: null,
  template: null,
});

/** one case the runner evaluates (a shipped case, or a reviewer override) */
export interface DecisionRegressionCase {
  id: string;
  label: string;
  source: "shipped" | "override";
  answers: Record<string, unknown>;
  /** the expectation; only the fields present are compared (an override
   * usually pins the tier, say). null = nothing expected. */
  expected: Partial<DecisionOutcome> | null;
}

export interface DecisionRegressionCaseResult {
  caseId: string;
  label: string;
  source: "shipped" | "override";
  outcome: DecisionOutcome;
  /** the expected fields this outcome does not meet, in outcome order */
  unmetExpectation: DecisionOutcomeField[];
}

export interface DecisionRegressionResult {
  results: DecisionRegressionCaseResult[];
  /** cases whose outcome differs from their expectation (`before` = expected) */
  expectedDiff: RegressionDiff;
  /** with a baseline: cases whose outcome the configuration change alters */
  baselineDiff: RegressionDiff | null;
}

const EU_KEYS = [
  "purposeDomain",
  "affectedPersons",
  "decisionAutonomy",
  "biometricUse",
  "emotionRecognition",
  "socialScoring",
  "manipulativeTechniques",
  "profilesNaturalPersons",
  "safetyComponent",
  "interactsWithHumans",
  "generatesSyntheticContent",
] as const;

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function signoffApprovers(template: DecisionRegressionTemplate | null): readonly string[] {
  if (!template) return DEFAULT_INTAKE_SIGNOFF_APPROVERS;
  const stages = template.definition.stages ?? [];
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i]!;
    if (s.type === "human_approval") return s.approvers ?? [];
  }
  return [];
}

function rolesFor(policy: ReviewPolicyStoredBody | null, tier: ReviewPolicyTierKey): string[] {
  if (!policy) return [];
  const defined = new Set(policy.roles.map((r) => r.id));
  return (policy.tiers[tier]?.roleIds ?? []).filter((id) => defined.has(id));
}

function testsFor(policy: RequiredTestPolicy | null, tier: ReviewPolicyTierKey): string[] {
  const eff = effectiveRequiredTests(tier, policy);
  return eff.classes.map((c) => {
    const t = requiredTestThresholds(c);
    return (
      c.testClass +
      (t.maxAsr !== null ? ` maxAsr<=${t.maxAsr}%` : "") +
      (t.minScore !== null ? ` minScore>=${t.minScore}` : "") +
      ` within ${eff.freshnessDays}d`
    );
  });
}

/**
 * What `config` decides for one set of answers. Answers the server would
 * refuse (a missing or unknown key, a "Not sure" stored beside a no) are
 * unscreened: no tier, and the unscreened tier's roles, tests and routing —
 * which is how the gateway treats a use case without a valid answers block.
 */
export function decisionOutcomeFor(answers: Record<string, unknown>, config: DecisionRegressionConfig): DecisionOutcome {
  const parsed = intakeScreeningAnswersSchema.safeParse(answers);
  let tier: ReturnType<typeof classifyEuAiActTier>["tier"] | null = null;
  const reasons: string[] = [];
  let frameworks: string[] = [];
  let suggestedControls: string[] = [];
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    reasons.push(`answers refused: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid"}`);
  } else {
    const unsure = parsed.data.unsure ?? [];
    const violations = unsureAnswerViolations(parsed.data, unsure, INTAKE_BOOLEAN_QUESTION_KEYS);
    if (violations.length > 0) {
      reasons.push(`answers refused: unsure_answer_must_count_as_yes (${violations.join(", ")})`);
    } else {
      const eu = Object.fromEntries(EU_KEYS.map((k) => [k, parsed.data[k]])) as EuAiActAnswers;
      const classification = classifyEuAiActTier(eu);
      tier = classification.tier;
      for (const r of classification.reasons) reasons.push(`${r.ruleId} (${r.ref})`);
      for (const k of unsure) reasons.push(`not sure: ${k} counted as yes`);
      const s = suggestIntake({
        title: "decision regression case",
        description: "decision regression case",
        euAiAct: eu,
        context: {
          sectors: parsed.data.sectors,
          dataCategories: parsed.data.dataCategories,
          deployment: parsed.data.deployment,
          euNexus: parsed.data.euNexus,
          usesExternalVendor: parsed.data.usesExternalVendor,
          generative: parsed.data.generative,
          autonomousActions: parsed.data.autonomousActions,
          toolsUsed: parsed.data.toolsUsed,
        },
        draftNarrative: false,
      });
      frameworks = s.frameworks.map((f) => f.framework);
      suggestedControls = sortedUnique(s.risks.flatMap((r) => r.suggestedControls));
    }
  }
  const key: ReviewPolicyTierKey = tier ?? "unscreened";
  const requiredRoles = rolesFor(config.reviewPolicy, key);
  return {
    tier,
    reasons,
    frameworks,
    requiredRoles,
    requiredTests: testsFor(config.requiredTests, key),
    suggestedControls,
    approverRouting:
      requiredRoles.length > 0
        ? `review roles: ${requiredRoles.join(", ")}`
        : `single approver: ${signoffApprovers(config.template).join(", ") || "none named"}`,
  };
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** the fields of `after` that differ from `before`, in outcome order; with
 * `only`, just those fields are compared (a partial expectation) */
export function diffDecisionOutcomes(
  before: Partial<DecisionOutcome>,
  after: DecisionOutcome,
  only?: readonly DecisionOutcomeField[],
): DecisionOutcomeField[] {
  return DECISION_OUTCOME_FIELDS.filter((f) => (only ? only.includes(f) : true) && !same(before[f], after[f]));
}

/** the outcome fields an expectation names (unknown keys are ignored) */
export function expectedFields(expected: Partial<DecisionOutcome> | null): DecisionOutcomeField[] {
  if (!expected) return [];
  return DECISION_OUTCOME_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(expected, f));
}

/**
 * THE RUNNER. Pure: the same cases and configurations give the same result.
 * `opts.baseline` is the configuration live today; with it, `baselineDiff`
 * lists the cases whose outcome `config` would change.
 */
export function runDecisionRegression(
  cases: readonly DecisionRegressionCase[],
  config: DecisionRegressionConfig,
  opts: { baseline?: DecisionRegressionConfig } = {},
): DecisionRegressionResult {
  const results: DecisionRegressionCaseResult[] = [];
  const expectedEntries: RegressionCaseDiff[] = [];
  const baselineEntries: RegressionCaseDiff[] = [];
  for (const c of cases) {
    const outcome = decisionOutcomeFor(c.answers, config);
    const fields = expectedFields(c.expected);
    const unmet = fields.length ? diffDecisionOutcomes(c.expected!, outcome, fields) : [];
    results.push({ caseId: c.id, label: c.label, source: c.source, outcome, unmetExpectation: unmet });
    if (unmet.length > 0) {
      expectedEntries.push({
        caseId: c.id,
        label: c.label,
        changed: unmet,
        before: { ...outcome, ...c.expected } as DecisionOutcome,
        after: outcome,
      });
    }
    if (opts.baseline) {
      const before = decisionOutcomeFor(c.answers, opts.baseline);
      const changed = diffDecisionOutcomes(before, outcome);
      if (changed.length > 0) baselineEntries.push({ caseId: c.id, label: c.label, changed, before, after: outcome });
    }
  }
  return {
    results,
    expectedDiff: { cases: cases.length, changed: expectedEntries.length, entries: expectedEntries },
    baselineDiff: opts.baseline ? { cases: cases.length, changed: baselineEntries.length, entries: baselineEntries } : null,
  };
}

/** the shipped set as runner cases, each with its expected outcome */
export function shippedDecisionRegressionCases(): DecisionRegressionCase[] {
  return SHIPPED_GOLDEN_CASES.map((c) => ({
    id: c.id,
    label: c.label,
    source: "shipped" as const,
    answers: c.answers,
    expected: GOLDEN_EXPECTED[c.id] ?? null,
  }));
}

/** the versions of the code-side rules a decision (and the golden set) cites */
export function decisionRuleVersions(): { euAiActRulesetVersion: number; intakeAssistVersion: string } {
  return { euAiActRulesetVersion: EU_AI_ACT_RULESET_VERSION, intakeAssistVersion: INTAKE_ASSIST_RULES_VERSION };
}

// ---------------------------------------------------------------------------
// The candidates: the bodies a preview names and an activation submits
// ---------------------------------------------------------------------------

/** an `ai-use-case-intake/*` variant: created from a gallery shape (with an
 * optional concrete approver), or from a whole definition */
export const intakeTemplateCandidateSchema = z.union([
  z
    .object({
      galleryId: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      approverUserId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1).max(200),
      definition: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type IntakeTemplateCandidate = z.infer<typeof intakeTemplateCandidateSchema>;

/** the fields an activation write carries besides the body itself */
export const DECISION_REGRESSION_ACCEPTANCE_KEYS = ["regressionRunId", "acceptChangedOutcomes", "acceptReason"] as const;

/** the write body without the acceptance fields (what is digested) */
export function withoutAcceptance(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((body ?? {}) as Record<string, unknown>) };
  for (const k of DECISION_REGRESSION_ACCEPTANCE_KEYS) delete out[k];
  return out;
}

export type DecisionRegressionCandidate =
  | { ok: true; subject: "review_policy"; normalized: ReviewPolicyStoredBody; digest: string }
  | { ok: true; subject: "required_tests"; normalized: RequiredTestPolicy; digest: string }
  | { ok: true; subject: "intake_template"; normalized: IntakeTemplateCandidate; digest: string }
  | { ok: false; issues: z.ZodIssue[] };

/**
 * Parse and normalise a candidate body exactly as its write would, and digest
 * it. The acceptance fields are not part of the body. The intake-template
 * name is part of the digest (it is what the intake resolution reads).
 */
export function decisionRegressionCandidate(subject: DecisionRegressionSubject, raw: unknown): DecisionRegressionCandidate {
  const body = withoutAcceptance(raw);
  switch (subject) {
    case "review_policy": {
      const p = reviewPolicyInputSchema.safeParse(body);
      if (!p.success) return { ok: false, issues: p.error.issues };
      const normalized = reviewPolicyStoredBody(p.data);
      return { ok: true, subject, normalized, digest: accountabilityDigest(normalized) };
    }
    case "required_tests": {
      const p = requiredTestPolicySchema.safeParse(body);
      if (!p.success) return { ok: false, issues: p.error.issues };
      const normalized = p.data as RequiredTestPolicy;
      return { ok: true, subject, normalized, digest: accountabilityDigest(normalized) };
    }
    case "intake_template": {
      const p = intakeTemplateCandidateSchema.safeParse(body);
      if (!p.success) return { ok: false, issues: p.error.issues };
      const normalized = p.data;
      return { ok: true, subject, normalized, digest: accountabilityDigest(normalized) };
    }
  }
}

/** the digest of a live review policy (the same normalisation as a candidate) */
export function reviewPolicyBodyDigest(policy: ReviewPolicyStoredBody | null): string {
  return accountabilityDigest(policy ?? { roles: [], tiers: {}, riskAcceptorUserIds: [] });
}

/** the digest of a live required-tests policy (`{}` = every tier strict) */
export function requiredTestsDigest(policy: RequiredTestPolicy | null | undefined): string {
  return accountabilityDigest(policy ?? {});
}

/** is `name` the intake template or one of its variants (ADR-0165)? */
export function isIntakeTemplateName(name: string): boolean {
  return name === "ai-use-case-intake" || name.startsWith("ai-use-case-intake/");
}

/** a review policy view or stored row, reduced to the regression's shape */
export function reviewPolicyForRegression(
  row: { roles: unknown; tiers: unknown; riskAcceptorUserIds: unknown } | null,
): ReviewPolicyStoredBody | null {
  if (!row) return null;
  const tiers: ReviewPolicyStoredBody["tiers"] = {};
  const stored = (row.tiers ?? {}) as Record<string, { roleIds?: string[]; validityMonths?: number }>;
  for (const key of REVIEW_POLICY_TIER_KEYS) {
    const t = stored[key];
    if (t) tiers[key] = { roleIds: [...(t.roleIds ?? [])], ...(t.validityMonths !== undefined ? { validityMonths: t.validityMonths } : {}) };
  }
  return {
    roles: ((row.roles ?? []) as ReviewPolicyStoredBody["roles"]).map((r) => ({ id: r.id, name: r.name, memberUserIds: [...r.memberUserIds] })),
    tiers,
    riskAcceptorUserIds: [...((row.riskAcceptorUserIds ?? []) as string[])],
  };
}

// ---------------------------------------------------------------------------
// The API views
// ---------------------------------------------------------------------------

/** a changed reason line, as the gateway's text diff reports it */
export interface ReasonDiffPart {
  value: string;
  added: boolean;
  removed: boolean;
}

/** one baseline diff entry as a run stores and serves it */
export interface DecisionRegressionRunEntry extends RegressionCaseDiff {
  source: "shipped" | "override";
  /** line diff of `before.reasons` → `after.reasons` */
  reasonsDiff: ReasonDiffPart[];
}

export interface DecisionRegressionRunView {
  id: string;
  trigger: "ci" | "preview" | "activation";
  subject: DecisionRegressionSubject;
  candidateDigest: string;
  baselineDigest: string | null;
  cases: number;
  changed: number;
  entries: DecisionRegressionRunEntry[];
  createdAt: string;
  createdByName: string | null;
  /** minutes until an activation no longer accepts this preview (preview only) */
  expiresAt: string | null;
}

export interface DecisionRegressionCaseView {
  id: string;
  source: "shipped" | "override";
  label: string;
  answers: Record<string, unknown>;
  expected: Partial<DecisionOutcome> | null;
  fromUseCaseId: string | null;
  createdAt: string | null;
  createdByName: string | null;
  /** the outcome under the live configuration, and what it misses */
  outcome: DecisionOutcome;
  unmetExpectation: DecisionOutcomeField[];
}

/** what an activation write reports about the gate */
export interface DecisionRegressionGateReport {
  mode: "off" | "warn" | "enforce";
  /** `previewed`: a matching run admitted the write; `warned`: warn mode let
   * an unpreviewed or unaccepted write through; `skipped`: the gate is off */
  outcome: "previewed" | "warned" | "skipped";
  runId: string | null;
  activationRunId: string | null;
  changed: number | null;
  detail: string;
}

export interface UseCaseDecisionRecordView {
  id: string;
  outcome: "approved" | "rejected" | "needs_info";
  decidedAt: string;
  decidedByName: string | null;
  approvalId: string | null;
  workflowInstanceId: string | null;
  reviewPolicyVersion: number | null;
  requiredTestsDigest: string | null;
  intakeTemplateId: string | null;
  intakeTemplateName: string | null;
  intakeDefinitionDigest: string | null;
  euAiActRulesetVersion: number | null;
  intakeAssistVersion: string | null;
  answersDigest: string | null;
}
