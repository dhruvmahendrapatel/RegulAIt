/**
 * ADR-0182 (ADR-0175 batch D4) A11 — DECISION REGRESSION, AND DECISIONS THAT
 * CITE THEIR VERSIONS. OWNER: A11 (D4).
 *
 * NIST AI RMF MEASURE 1.2, MEASURE 2.13, GOVERN 1.4. Three things live here:
 *
 * 1. DECISION RECORDS. `writeUseCaseDecisionRecord` writes one
 *    `use_case_decision_records` row for every terminal intake sign-off
 *    decision (approved, rejected, returned for information), inside the
 *    decision's own transaction: the review-policy version, the digest of the
 *    required-tests policy, the intake template (id, name, digest of the
 *    definition the instance ran), the screening rule-set version, the
 *    suggestion-rules version and the digest of the answers. It never
 *    swallows an error, so a decision whose record cannot be written rolls
 *    back with it. The table is append-only (migration 0162).
 *
 * 2. THE PREVIEW. `POST /v1/governance/decision-regression/preview` runs the
 *    golden set (the shipped cases plus reviewer overrides) under the live
 *    configuration and under the candidate body, stores the run with the
 *    candidate's digest and the live configuration's digest, and returns the
 *    cases whose outcome the change would alter.
 *
 * 3. THE ACTIVATION GATE. `checkDecisionRegressionGate` is called by the
 *    review-policy PUT, the required-tests PUT and every write that changes
 *    which intake template decides sign-off: creating an
 *    `ai-use-case-intake/*` template or variant (from a definition or the
 *    gallery) and retiring the active one (D4G-04), through
 *    `writeIntakeTemplateGated`, which takes one lock, checks, writes and
 *    records in ONE transaction (D4G-07). Under `enforce` (the strict
 *    default, ADR-0180 §1) the write needs `regressionRunId` naming a
 *    preview of the SAME subject whose candidate digest equals the submitted
 *    body's, no older than `decision_regression_max_age_minutes`, taken
 *    against the configuration still live AND the golden set still live
 *    (X15-R01: a case added, retired or changed since the preview means the
 *    run no longer covers the current cases); and, if that run changed any
 *    outcome, `acceptChangedOutcomes: true` with an `acceptReason`. Refusals
 *    are 409 `decision_regression_not_previewed` /
 *    `decision_regression_changes_unaccepted`, audited. `warn` records the
 *    problem, computes the regression now so the activation still has a
 *    record, and allows; `off` skips the check and the response says so.
 *
 * OPEN SOURCE FIRST (ADR-0176): `diff` (jsdiff, BSD-3, already a gateway
 * dependency) produces the line diff of changed reasons; the outcome diff is
 * the shared runner's field-by-field comparison (jsondiffpatch and microdiff
 * considered; none needed, see packages/shared/src/decision-regression.ts).
 *
 * Load order (ADR-0180 FA10): nothing here reads an imported binding at load
 * time; the template gallery is imported lazily (it imports this module).
 */
import type { FastifyInstance } from "fastify";
import { diffArrays } from "diff";
import { z } from "zod";
import { validateDefinition } from "@regulait/workflow-kernel";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  decisionRegressionCases,
  decisionRegressionRuns,
  desc,
  eq,
  governanceReviewPolicy,
  governanceReviewPolicyVersions,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  useCaseDecisionRecords,
  users,
  workflowInstances,
  workflowTemplates,
  type AiUseCaseRow,
  type Db,
  type DecisionRegressionRunRow,
} from "@regulait/db";
import {
  DECISION_OUTCOME_FIELDS,
  DECISION_REGRESSION_SUBJECTS,
  EU_AI_ACT_TIERS,
  accountabilityDigest,
  createDecisionRegressionCaseSchema,
  decisionOutcomeFor,
  decisionRegressionAcceptanceFields,
  decisionRegressionCandidate,
  decisionRegressionPreviewSchema,
  decisionRuleVersions,
  expectedFields,
  intakeTemplateDigest,
  isIntakeTemplateName,
  requiredTestsDigest,
  reviewPolicyBodyDigest,
  reviewPolicyForRegression,
  runDecisionRegression,
  shippedDecisionRegressionCases,
  SHIPPED_GOLDEN_CASES,
  type AccountabilityGateMode,
  type DecisionOutcome,
  type DecisionRegressionCase,
  type DecisionRegressionCaseView,
  type DecisionRegressionConfig,
  type DecisionRegressionGateReport,
  type DecisionRegressionRunEntry,
  type DecisionRegressionRunView,
  type DecisionRegressionSubject,
  type DecisionRegressionTemplate,
  type IntakeTemplateCandidate,
  type RegressionDiff,
  type ResolvedIntakeTemplate,
  type RequiredTestPolicy,
  type UseCaseDecision,
  type UseCaseDecisionRecordView,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const POLICY_ID = "default";
/** reviewer-override cases kept live at once (a preview runs them all) */
export const MAX_ACTIVE_OVERRIDE_CASES = 500;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Writer = Db | Tx;

const asDb = (w: Writer) => w as unknown as Db;

// ---------------------------------------------------------------------------
// The live configuration
// ---------------------------------------------------------------------------

export interface LiveDecisionConfig {
  config: DecisionRegressionConfig;
  /** the live review-policy row's version (null = no row yet) */
  policyVersion: number | null;
  /** the active intake template (null = the built-in shape, not yet minted) */
  template: { id: string; name: string; definition: unknown } | null;
}

/** the newest ACTIVE `ai-use-case-intake` template or variant (the use-case
 * front door's resolution, read-only: nothing is minted here) */
export async function activeIntakeTemplate(db: Writer): Promise<{ id: string; name: string; definition: unknown } | null> {
  const rows = await asDb(db)
    .select({ id: workflowTemplates.id, name: workflowTemplates.name, definition: workflowTemplates.definition })
    .from(workflowTemplates)
    .where(
      and(
        isNull(workflowTemplates.retiredAt),
        or(eq(workflowTemplates.name, "ai-use-case-intake"), sql`${workflowTemplates.name} like ${"ai-use-case-intake/%"}`),
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** what produces intake decisions right now, as the regression reads it */
export async function loadLiveDecisionConfig(db: Writer): Promise<LiveDecisionConfig> {
  const [row] = await asDb(db).select().from(governanceReviewPolicy).where(eq(governanceReviewPolicy.id, POLICY_ID));
  const template = await activeIntakeTemplate(db);
  return {
    config: {
      reviewPolicy: reviewPolicyForRegression(row ?? null),
      requiredTests: ((row?.requiredTests ?? {}) as RequiredTestPolicy) ?? {},
      template: template ? { name: template.name, definition: template.definition as DecisionRegressionTemplate["definition"] } : null,
    },
    policyVersion: row?.version ?? null,
    template,
  };
}

/** the digest of the live configuration a subject's write replaces */
export function baselineDigestFor(subject: DecisionRegressionSubject, live: LiveDecisionConfig): string {
  switch (subject) {
    case "review_policy":
      return reviewPolicyBodyDigest(live.config.reviewPolicy);
    case "required_tests":
      return requiredTestsDigest(live.config.requiredTests);
    case "intake_template":
      return accountabilityDigest(
        live.template ? { id: live.template.id, name: live.template.name, definition: live.template.definition } : { builtIn: "ai-use-case-intake" },
      );
  }
}

/** the golden set: the shipped cases, then the live reviewer overrides */
export async function loadRegressionCases(db: Writer): Promise<DecisionRegressionCase[]> {
  const overrides = await asDb(db)
    .select()
    .from(decisionRegressionCases)
    .where(isNull(decisionRegressionCases.retiredAt))
    .orderBy(decisionRegressionCases.createdAt, decisionRegressionCases.id);
  return [
    ...shippedDecisionRegressionCases(),
    ...overrides.map((r) => ({
      id: r.id,
      label: r.label,
      source: r.source,
      answers: r.answers,
      expected: r.expected as Partial<DecisionOutcome>,
    })),
  ];
}

/**
 * X15-R01: the digest of the golden set a run replays — every case's id,
 * source, answers and expectation, in run order. A preview records it; the
 * gate admits the preview only while the live set still has the same digest.
 */
export function caseSetDigest(cases: DecisionRegressionCase[]): string {
  return accountabilityDigest(cases.map((c) => ({ id: c.id, source: c.source, answers: c.answers, expected: c.expected })));
}

// ---------------------------------------------------------------------------
// One computation (a preview, or a warn-mode activation)
// ---------------------------------------------------------------------------

export interface ComputedRegression {
  subject: DecisionRegressionSubject;
  candidateDigest: string;
  baselineDigest: string;
  /** the golden set this computation replayed (X15-R01) */
  caseSetDigest: string;
  diff: RegressionDiff;
  entries: DecisionRegressionRunEntry[];
}

/** the baseline diff with each entry's source and its reasons' line diff */
function runEntries(cases: DecisionRegressionCase[], diff: RegressionDiff): DecisionRegressionRunEntry[] {
  const source = new Map(cases.map((c) => [c.id, c.source]));
  return diff.entries.map((e) => ({
    ...e,
    source: source.get(e.caseId) ?? "shipped",
    reasonsDiff: diffArrays(e.before?.reasons ?? [], e.after.reasons).flatMap((part) =>
      part.value.map((value) => ({ value, added: !!part.added, removed: !!part.removed })),
    ),
  }));
}

export async function computeRegression(
  db: Writer,
  subject: DecisionRegressionSubject,
  candidateDigest: string,
  candidate: Partial<DecisionRegressionConfig>,
  live: LiveDecisionConfig,
): Promise<ComputedRegression> {
  const cases = await loadRegressionCases(db);
  const run = runDecisionRegression(cases, { ...live.config, ...candidate }, { baseline: live.config });
  const diff = run.baselineDiff!;
  return {
    subject,
    candidateDigest,
    baselineDigest: baselineDigestFor(subject, live),
    caseSetDigest: caseSetDigest(cases),
    diff,
    entries: runEntries(cases, diff),
  };
}

async function insertRun(
  db: Writer,
  trigger: "preview" | "activation",
  c: Pick<ComputedRegression, "subject" | "candidateDigest" | "baselineDigest" | "entries"> & { cases: number; changed: number },
  actorUserId: string | null,
): Promise<DecisionRegressionRunRow> {
  const [row] = await asDb(db)
    .insert(decisionRegressionRuns)
    .values({
      trigger,
      subject: c.subject,
      candidateDigest: c.candidateDigest,
      baselineDigest: c.baselineDigest,
      cases: c.cases,
      changed: c.changed,
      diff: c.entries,
      createdBy: actorUserId,
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// The activation gate
// ---------------------------------------------------------------------------

export const DECISION_REGRESSION_NOT_PREVIEWED = "decision_regression_not_previewed" as const;
export const DECISION_REGRESSION_CHANGES_UNACCEPTED = "decision_regression_changes_unaccepted" as const;

/** the acceptance fields, as an activation write carries them */
export const decisionRegressionAcceptanceSchema = z.object(decisionRegressionAcceptanceFields);
export type DecisionRegressionAcceptance = z.infer<typeof decisionRegressionAcceptanceSchema>;

/** pick and validate the acceptance fields of a raw write body */
export function parseAcceptance(
  raw: unknown,
): { ok: true; value: DecisionRegressionAcceptance } | { ok: false; issues: z.ZodIssue[] } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const p = decisionRegressionAcceptanceSchema.safeParse({
    ...(b.regressionRunId !== undefined ? { regressionRunId: b.regressionRunId } : {}),
    ...(b.acceptChangedOutcomes !== undefined ? { acceptChangedOutcomes: b.acceptChangedOutcomes } : {}),
    ...(b.acceptReason !== undefined ? { acceptReason: b.acceptReason } : {}),
  });
  return p.success ? { ok: true, value: p.data } : { ok: false, issues: p.error.issues };
}

const SUBJECT_COPY: Record<DecisionRegressionSubject, string> = {
  review_policy: "the review policy",
  required_tests: "the required AI tests",
  intake_template: "the intake template",
};

interface GateProblem {
  code: typeof DECISION_REGRESSION_NOT_PREVIEWED | typeof DECISION_REGRESSION_CHANGES_UNACCEPTED;
  reason:
    | "missing"
    | "unknown_run"
    | "subject_mismatch"
    | "digest_mismatch"
    | "stale"
    | "baseline_moved"
    | "cases_changed"
    | "changes_unaccepted";
  detail: string;
  run: DecisionRegressionRunRow | null;
}

export type GateVerdict =
  | {
      ok: true;
      mode: AccountabilityGateMode;
      /** the preview that admitted the write (enforce or warn with no problem) */
      run: DecisionRegressionRunRow | null;
      /** the problem warn mode let through */
      problem: GateProblem | null;
    }
  | { ok: false; mode: AccountabilityGateMode; problem: GateProblem };

export interface GateInput {
  subject: DecisionRegressionSubject;
  candidateDigest: string;
  baselineDigest: string;
  acceptance: DecisionRegressionAcceptance;
  now?: Date;
}

const previewHint = (subject: DecisionRegressionSubject) =>
  `POST /v1/governance/decision-regression/preview with subject '${subject}' and this exact body, review the ` +
  "outcomes it changes, then repeat this write with regressionRunId set to the run's id";

/**
 * THE CHECK (reads only). The caller holds its row lock, if it has one, so
 * the baseline it passes is the configuration its write replaces.
 */
export async function checkDecisionRegressionGate(db: Writer, input: GateInput): Promise<GateVerdict> {
  const settings = await loadOrgSettings(asDb(db));
  const mode = settings.decisionRegressionGate as AccountabilityGateMode;
  if (mode === "off") return { ok: true, mode, run: null, problem: null };
  const now = input.now ?? new Date();
  const what = SUBJECT_COPY[input.subject];
  let admitted: DecisionRegressionRunRow | null = null;
  const problem = await (async (): Promise<GateProblem | null> => {
    const runId = input.acceptance.regressionRunId;
    if (!runId) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "missing",
        detail: `a change to ${what} needs a decision-regression preview first: ${previewHint(input.subject)}`,
        run: null,
      };
    }
    const [run] = await asDb(db).select().from(decisionRegressionRuns).where(eq(decisionRegressionRuns.id, runId));
    if (!run || run.trigger !== "preview") {
      return { code: DECISION_REGRESSION_NOT_PREVIEWED, reason: "unknown_run", detail: `no preview run ${runId} exists: ${previewHint(input.subject)}`, run: null };
    }
    if (run.subject !== input.subject) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "subject_mismatch",
        detail: `run ${run.id} previewed ${SUBJECT_COPY[run.subject]}, not ${what}: ${previewHint(input.subject)}`,
        run,
      };
    }
    if (run.candidateDigest !== input.candidateDigest) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "digest_mismatch",
        detail: `run ${run.id} previewed a different body than the one submitted (digest ${run.candidateDigest.slice(0, 12)}…, submitted ${input.candidateDigest.slice(0, 12)}…): ${previewHint(input.subject)}`,
        run,
      };
    }
    const maxAgeMs = settings.decisionRegressionMaxAgeMinutes * 60_000;
    if (now.getTime() - run.createdAt.getTime() > maxAgeMs) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "stale",
        detail: `run ${run.id} is older than ${settings.decisionRegressionMaxAgeMinutes} minute(s): preview again`,
        run,
      };
    }
    if (run.baselineDigest !== input.baselineDigest) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "baseline_moved",
        detail: `${what} changed after run ${run.id} was taken, so its comparison is out of date: preview again`,
        run,
      };
    }
    // X15-R01: the run covers the golden set it replayed. Its digest is in the
    // preview's own audit row (written in the run's transaction); a case added,
    // retired or changed since — or no recorded digest — means it does not
    // cover the cases live now.
    const previewed = await previewCaseSetDigest(db, run);
    if (previewed === null || previewed !== caseSetDigest(await loadRegressionCases(db))) {
      return {
        code: DECISION_REGRESSION_NOT_PREVIEWED,
        reason: "cases_changed",
        detail:
          `the golden cases changed after run ${run.id} was taken (a case was added, retired or changed), ` +
          "so it does not cover the cases live now: preview again",
        run,
      };
    }
    if (run.changed > 0 && !(input.acceptance.acceptChangedOutcomes === true && input.acceptance.acceptReason)) {
      return {
        code: DECISION_REGRESSION_CHANGES_UNACCEPTED,
        reason: "changes_unaccepted",
        detail:
          `run ${run.id} shows this change alters the outcome of ${run.changed} of ${run.cases} golden case(s); ` +
          "repeat the write with acceptChangedOutcomes: true and an acceptReason (at least 10 characters)",
        run,
      };
    }
    admitted = run;
    return null;
  })();
  if (!problem) return { ok: true, mode, run: admitted, problem: null };
  if (mode === "warn") return { ok: true, mode, run: problem.run, problem };
  return { ok: false, mode, problem };
}

/**
 * The case-set digest a preview recorded, read from its `decision-regression-
 * previewed` audit row. That row is written in the run's own transaction with
 * the same `now()`, so `(user_id, at)` (indexed) finds it without scanning the
 * trail; the id and rule pin it exactly. Null when absent (a run whose author
 * was since deleted, so `created_by` no longer names the row's user; a pruned
 * row; a preview from before X15-R01): the gate then refuses, and a fresh
 * preview is the remedy. Kept in the audit row so no migration was needed; a
 * `case_set_digest` column on the run would carry it the same way.
 */
async function previewCaseSetDigest(db: Writer, run: DecisionRegressionRunRow): Promise<string | null> {
  const from = new Date(run.createdAt.getTime() - 1000);
  const to = new Date(run.createdAt.getTime() + 1000);
  const [row] = await asDb(db)
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, run.createdBy ?? NO_IDENTITY),
        gte(auditLog.at, from),
        lte(auditLog.at, to),
        eq(auditLog.objectType, "decision_regression"),
        eq(auditLog.objectId, run.id),
        eq(auditLog.ruleId, "decision-regression-previewed"),
      ),
    )
    .limit(1);
  const digest = (row?.detail as { caseSetDigest?: unknown } | null | undefined)?.caseSetDigest;
  return typeof digest === "string" ? digest : null;
}

/** the 409 body and the audit row of a refusal (written by the caller AFTER
 * its transaction, so the refusal is recorded though nothing else is) */
export async function refuseDecisionRegression(
  db: Writer,
  verdict: Extract<GateVerdict, { ok: false }>,
  ctx: { subject: DecisionRegressionSubject; candidateDigest: string; actorUserId: string | null },
): Promise<{ status: 409; body: Record<string, unknown> }> {
  const p = verdict.problem;
  await asDb(db).insert(auditLog).values({
    userId: ctx.actorUserId ?? NO_IDENTITY,
    objectType: "decision_regression",
    objectId: p.run?.id ?? null,
    detail: {
      phase: "activation-refused",
      subject: ctx.subject,
      code: p.code,
      reason: p.reason,
      mode: verdict.mode,
      candidateDigest: ctx.candidateDigest,
      runId: p.run?.id ?? null,
      changed: p.run?.changed ?? null,
    },
    effect: "deny",
    ruleId: "decision-regression-gate-refused",
    ruleChain: [],
    reason: `change to ${SUBJECT_COPY[ctx.subject]} REFUSED (${p.code}, ${p.reason}): ${p.detail}`,
  });
  return {
    status: 409,
    body: {
      error: p.code,
      reason: p.reason,
      subject: ctx.subject,
      detail: p.detail,
      ...(p.run ? { runId: p.run.id, changed: p.run.changed, cases: p.run.cases } : {}),
    },
  };
}

/**
 * Record an admitted activation, inside the caller's write transaction: an
 * `activation` run (the preview's diff, or — in warn mode without a usable
 * preview — the regression computed now) and the audit row. Returns what the
 * write's response reports.
 */
export async function recordDecisionRegressionActivation(
  db: Writer,
  verdict: Extract<GateVerdict, { ok: true }>,
  ctx: {
    subject: DecisionRegressionSubject;
    candidateDigest: string;
    acceptance: DecisionRegressionAcceptance;
    actorUserId: string | null;
    /** computes the regression now (warn mode without a usable preview) */
    computeNow: () => Promise<ComputedRegression>;
  },
): Promise<DecisionRegressionGateReport> {
  const what = SUBJECT_COPY[ctx.subject];
  if (verdict.mode === "off") {
    const detail =
      `the decision regression gate is off: this change to ${what} was not checked against the golden set, ` +
      "so outcomes it alters were not previewed (an admin relaxed decision_regression_gate)";
    await asDb(db).insert(auditLog).values({
      userId: ctx.actorUserId ?? NO_IDENTITY,
      objectType: "decision_regression",
      objectId: null,
      detail: { phase: "activation-skipped", subject: ctx.subject, mode: "off", candidateDigest: ctx.candidateDigest },
      effect: "allow",
      ruleId: "decision-regression-gate-skipped",
      ruleChain: [],
      reason: detail,
    });
    return { mode: "off", outcome: "skipped", runId: null, activationRunId: null, changed: null, detail };
  }
  const usable = verdict.problem === null && verdict.run !== null;
  let source: { cases: number; changed: number; entries: DecisionRegressionRunEntry[]; baselineDigest: string | null };
  if (usable) {
    const r = verdict.run!;
    source = { cases: r.cases, changed: r.changed, entries: r.diff as DecisionRegressionRunEntry[], baselineDigest: r.baselineDigest };
  } else {
    const c = await ctx.computeNow();
    source = { cases: c.diff.cases, changed: c.diff.changed, entries: c.entries, baselineDigest: c.baselineDigest };
  }
  const activation = await insertRun(
    db,
    "activation",
    {
      subject: ctx.subject,
      candidateDigest: ctx.candidateDigest,
      baselineDigest: source.baselineDigest ?? "",
      entries: source.entries,
      cases: source.cases,
      changed: source.changed,
    },
    ctx.actorUserId,
  );
  const warned = verdict.problem !== null;
  const detail = warned
    ? `decision regression gate in warn mode: ${verdict.problem!.detail} — saved anyway; the outcomes this change ` +
      `alters (${source.changed} of ${source.cases}) are recorded in run ${activation.id}`
    : `previewed in run ${verdict.run!.id}: ${source.changed} of ${source.cases} golden case(s) change` +
      (source.changed > 0 ? `, accepted: ${ctx.acceptance.acceptReason}` : "");
  await asDb(db).insert(auditLog).values({
    userId: ctx.actorUserId ?? NO_IDENTITY,
    objectType: "decision_regression",
    objectId: activation.id,
    detail: {
      phase: warned ? "activation-warned" : "activation-previewed",
      subject: ctx.subject,
      mode: verdict.mode,
      candidateDigest: ctx.candidateDigest,
      previewRunId: verdict.run?.id ?? null,
      activationRunId: activation.id,
      cases: source.cases,
      changed: source.changed,
      ...(warned ? { code: verdict.problem!.code, problemReason: verdict.problem!.reason } : {}),
      ...(ctx.acceptance.acceptChangedOutcomes ? { acceptChangedOutcomes: true, acceptReason: ctx.acceptance.acceptReason ?? null } : {}),
    },
    effect: "allow",
    ruleId: warned ? "decision-regression-gate-warned" : "decision-regression-activated",
    ruleChain: [],
    reason: `change to ${what} activated — ${detail}`,
  });
  return {
    mode: verdict.mode,
    outcome: warned ? "warned" : "previewed",
    runId: verdict.run?.id ?? null,
    activationRunId: activation.id,
    changed: source.changed,
    detail,
  };
}

/** D4G-07: every write that changes which intake template decides sign-off holds this transaction-scoped lock,
 * so two writes admitted by one preview (or a create racing a retire) serialise and the second sees the moved
 * baseline. */
export async function lockIntakeTemplateWrites(tx: Writer): Promise<void> {
  await asDb(tx).execute(sql`select pg_advisory_xact_lock(hashtext('regulait:intake-template-writes'))`);
}

type IntakeWriteResult<R> = { ok: true; value: R } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * THE GATE FOR AN INTAKE TEMPLATE WRITE (an `ai-use-case-intake` template or variant decides who signs off every
 * new use case). In ONE transaction (D4G-07): take the intake-template lock, resolve the candidate to the template
 * that will decide afterwards (D4G-12: its digest is over that resolved name and definition), check the gate against
 * the live configuration read under the lock, run the caller's write, and record the activation run and audit row.
 * A gate refusal is audited after the transaction (nothing else is written); a write that fails rolls back with
 * the record. `changesDecider` (a retirement) says whether this write changes the decider at all; when it does not,
 * the write runs under the lock without the gate, and the response says so (`decisionRegression: null`).
 */
export async function writeIntakeTemplateGated<R>(
  db: Db,
  args: {
    raw: unknown;
    candidate: IntakeTemplateCandidate;
    actorUserId: string | null;
    write: (tx: Db, resolved: ResolvedIntakeTemplate) => Promise<IntakeWriteResult<R>>;
    changesDecider?: (tx: Db, live: LiveDecisionConfig) => Promise<boolean>;
  },
): Promise<
  | { ok: true; value: R; decisionRegression: DecisionRegressionGateReport | null }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const acc = parseAcceptance(args.raw);
  if (!acc.ok) return { ok: false, status: 422, body: { error: "invalid_regression_acceptance", issues: acc.issues } };
  const out = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockIntakeTemplateWrites(tx);
    const live = await loadLiveDecisionConfig(tx);
    if (args.changesDecider && !(await args.changesDecider(tx, live))) {
      const written = await args.write(tx, live.template ? { name: live.template.name, definition: live.template.definition as DecisionRegressionTemplate["definition"] } : null);
      return written.ok ? ({ kind: "ok", value: written.value, report: null } as const) : ({ kind: "failed", result: written } as const);
    }
    const resolved = await resolveIntakeTemplateCandidate(args.candidate, tx);
    if (!resolved.ok) return { kind: "failed", result: resolved } as const;
    const verdict = await checkDecisionRegressionGate(tx, {
      subject: "intake_template",
      candidateDigest: resolved.digest,
      baselineDigest: baselineDigestFor("intake_template", live),
      acceptance: acc.value,
    });
    if (!verdict.ok) return { kind: "refused", verdict, digest: resolved.digest } as const;
    const written = await args.write(tx, resolved.template);
    if (!written.ok) return { kind: "failed", result: written } as const;
    const report = await recordDecisionRegressionActivation(tx, verdict, {
      subject: "intake_template",
      candidateDigest: resolved.digest,
      acceptance: acc.value,
      actorUserId: args.actorUserId,
      // computed only if warn mode let an unpreviewed write through
      computeNow: () => computeRegression(tx, "intake_template", resolved.digest, { template: resolved.template }, live),
    });
    return { kind: "ok", value: written.value, report } as const;
  });
  if (out.kind === "refused") {
    const refused = await refuseDecisionRegression(db, out.verdict, { subject: "intake_template", candidateDigest: out.digest, actorUserId: args.actorUserId });
    return { ok: false, status: refused.status, body: refused.body };
  }
  if (out.kind === "failed") return { ok: false, status: out.result.status, body: out.result.body };
  return { ok: true, value: out.value, decisionRegression: out.report };
}

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

/**
 * Write the record of one terminal sign-off decision, in the caller's
 * transaction. Deliberately NOT best-effort: a failure here throws, and the
 * decision rolls back with it (no record ⇒ no decision).
 */
export async function writeUseCaseDecisionRecord(
  db: Writer,
  input: {
    useCase: Pick<AiUseCaseRow, "id" | "workflowInstanceId" | "euAiActRulesetVersion" | "intakeAnswers">;
    outcome: UseCaseDecision;
    decidedAt: Date;
    decidedBy: string | null;
    /** the approval decided; omitted = the instance's latest decided approval;
     * null = no approval decided it (an aborted intake) */
    approvalId?: string | null;
  },
): Promise<{ id: string }> {
  const d = asDb(db);
  // re-read: the screening may have just recomputed the tier and its rule set
  const [fresh] = await d
    .select({ euAiActRulesetVersion: aiUseCases.euAiActRulesetVersion, intakeAnswers: aiUseCases.intakeAnswers })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, input.useCase.id));
  const rulesetVersion = fresh ? fresh.euAiActRulesetVersion : (input.useCase.euAiActRulesetVersion ?? null);
  const answers = fresh ? fresh.intakeAnswers : (input.useCase.intakeAnswers ?? null);
  const [policy] = await d
    .select({ version: governanceReviewPolicy.version, requiredTests: governanceReviewPolicy.requiredTests })
    .from(governanceReviewPolicy)
    .where(eq(governanceReviewPolicy.id, POLICY_ID));
  const instanceId = input.useCase.workflowInstanceId;
  let template: { id: string; name: string } | null = null;
  let definitionDigest: string | null = null;
  let approvalId = input.approvalId === undefined ? null : input.approvalId;
  if (instanceId) {
    const [inst] = await d
      .select({ templateIds: workflowInstances.templateIds, definition: workflowInstances.definition })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (inst) {
      definitionDigest = accountabilityDigest(inst.definition);
      const ids = (inst.templateIds ?? []) as string[];
      if (ids.length > 0) {
        const rows = await d
          .select({ id: workflowTemplates.id, name: workflowTemplates.name })
          .from(workflowTemplates)
          .where(inArray(workflowTemplates.id, ids));
        template = rows.find((r) => isIntakeTemplateName(r.name)) ?? rows[0] ?? null;
      }
    }
    if (input.approvalId === undefined) {
      const [last] = await d
        .select({ id: approvals.id })
        .from(approvals)
        // the instance's own sign-offs only — an engine run's approval (ADR-0187) is linked to it too
        .where(and(eq(approvals.instanceId, instanceId), eq(approvals.objectType, "workflow"), isNotNull(approvals.decidedAt)))
        .orderBy(desc(approvals.decidedAt))
        .limit(1);
      approvalId = last?.id ?? null;
    }
  }
  const versions = decisionRuleVersions();
  const [row] = await d
    .insert(useCaseDecisionRecords)
    .values({
      useCaseId: input.useCase.id,
      workflowInstanceId: instanceId ?? null,
      approvalId,
      outcome: input.outcome,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
      reviewPolicyVersion: policy?.version ?? null,
      requiredTestsDigest: requiredTestsDigest((policy?.requiredTests ?? {}) as RequiredTestPolicy),
      intakeTemplateId: template?.id ?? null,
      intakeTemplateName: template?.name ?? null,
      intakeDefinitionDigest: definitionDigest,
      euAiActRulesetVersion: rulesetVersion ?? null,
      intakeAssistVersion: versions.intakeAssistVersion,
      answersDigest: answers ? accountabilityDigest(answers) : null,
    })
    .returning({ id: useCaseDecisionRecords.id });
  return row!;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function namesOf(db: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

function runView(row: DecisionRegressionRunRow, names: Map<string, string>, maxAgeMinutes: number, withEntries = true): DecisionRegressionRunView {
  return {
    id: row.id,
    trigger: row.trigger,
    subject: row.subject,
    candidateDigest: row.candidateDigest,
    baselineDigest: row.baselineDigest,
    cases: row.cases,
    changed: row.changed,
    entries: withEntries ? (row.diff as DecisionRegressionRunEntry[]) : [],
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    expiresAt: row.trigger === "preview" ? new Date(row.createdAt.getTime() + maxAgeMinutes * 60_000).toISOString() : null,
  };
}

/** a reviewer override's expectation: some outcome fields, typed as the runner produces them */
const strList = z.array(z.string().min(1).max(500)).max(100);
export const expectedOutcomeSchema = z
  .object({
    tier: z.enum(EU_AI_ACT_TIERS).nullable().optional(),
    reasons: strList.optional(),
    frameworks: strList.optional(),
    requiredRoles: strList.optional(),
    requiredTests: strList.optional(),
    suggestedControls: strList.optional(),
    approverRouting: z.string().min(1).max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one outcome field the case must keep" });

const runIdParam = z.object({ runId: z.string().uuid() });
const caseIdParam = z.object({ caseId: z.string().min(1).max(200) });
const useCaseIdParam = z.object({ useCaseId: z.string().uuid() });
const runsQuery = z
  .object({
    subject: z.enum(DECISION_REGRESSION_SUBJECTS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** the newest ACTIVE intake template other than `excludeId` (what decides once `excludeId` is retired) */
async function activeIntakeTemplateExcept(db: Writer, excludeId: string): Promise<{ id: string; name: string; definition: unknown } | null> {
  const rows = await asDb(db)
    .select({ id: workflowTemplates.id, name: workflowTemplates.name, definition: workflowTemplates.definition })
    .from(workflowTemplates)
    .where(
      and(
        isNull(workflowTemplates.retiredAt),
        sql`${workflowTemplates.id} <> ${excludeId}`,
        or(eq(workflowTemplates.name, "ai-use-case-intake"), sql`${workflowTemplates.name} like ${"ai-use-case-intake/%"}`),
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

const NOT_AN_INTAKE_TEMPLATE = {
  ok: false as const,
  status: 422,
  body: { error: "not_an_intake_template", detail: "an intake template is named 'ai-use-case-intake' or 'ai-use-case-intake/<label>'" },
};

/**
 * Resolve an intake-template candidate to the template that decides sign-off once its write lands, and digest THAT
 * (D4G-12): `{name, definition}` with the definition validated exactly as the create stores it (the gallery shape
 * with its approver substituted, read now), or — for a retirement — the next active variant, or the built-in shape
 * (null) when none is left.
 */
export async function resolveIntakeTemplateCandidate(
  c: IntakeTemplateCandidate,
  db: Writer,
): Promise<{ ok: true; template: ResolvedIntakeTemplate; digest: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  let template: ResolvedIntakeTemplate;
  if ("retireTemplateId" in c) {
    const [tpl] = await asDb(db)
      .select({ id: workflowTemplates.id, name: workflowTemplates.name })
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, c.retireTemplateId));
    if (!tpl) return { ok: false, status: 404, body: { error: "unknown_template" } };
    if (!isIntakeTemplateName(tpl.name)) return NOT_AN_INTAKE_TEMPLATE;
    const next = await activeIntakeTemplateExcept(db, tpl.id);
    template = next ? { name: next.name, definition: next.definition as DecisionRegressionTemplate["definition"] } : null;
  } else if ("definition" in c) {
    if (!isIntakeTemplateName(c.name)) return NOT_AN_INTAKE_TEMPLATE;
    template = { name: c.name, definition: validateDefinition(c.definition) as unknown as DecisionRegressionTemplate["definition"] };
  } else {
    if (!isIntakeTemplateName(c.name)) return NOT_AN_INTAKE_TEMPLATE;
    const gallery = await import("./template-gallery.js");
    const { entries } = await gallery.buildTemplateGallery(asDb(db));
    const entry = entries.find((e) => e.galleryId === c.galleryId);
    if (!entry) return { ok: false, status: 404, body: { error: "unknown_gallery_entry" } };
    const definition = validateDefinition(gallery.galleryDefinitionWithApprover(entry.definition, c.approverUserId));
    template = { name: c.name, definition: definition as unknown as DecisionRegressionTemplate["definition"] };
  }
  return { ok: true, template, digest: intakeTemplateDigest(template) };
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A11 block):
 *   POST   /v1/governance/decision-regression/preview          admin
 *   GET    /v1/governance/decision-regression/runs             admin
 *   GET    /v1/governance/decision-regression/runs/:runId      admin
 *   GET    /v1/governance/decision-regression/cases            admin
 *   POST   /v1/governance/decision-regression/cases            admin
 *   DELETE /v1/governance/decision-regression/cases/:caseId    admin (retires the case)
 *   GET    /v1/use-cases/:useCaseId/decision-records           user: the use case's owner or an admin, in-handler
 */
export function registerDecisionRegressionRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/governance/decision-regression/preview", async (req, reply) => {
    const parsed = decisionRegressionPreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(422).send({ error: "invalid_preview", issues: parsed.error.issues });
    const { subject } = parsed.data;
    const candidate = decisionRegressionCandidate(subject, parsed.data.candidate);
    if (!candidate.ok) return reply.status(422).send({ error: "invalid_candidate", subject, issues: candidate.issues });
    const live = await loadLiveDecisionConfig(db);
    let override: Partial<DecisionRegressionConfig>;
    let candidateDigest: string;
    if (candidate.subject === "review_policy") {
      override = { reviewPolicy: candidate.normalized };
      candidateDigest = candidate.digest;
    } else if (candidate.subject === "required_tests") {
      override = { requiredTests: candidate.normalized };
      candidateDigest = candidate.digest;
    } else {
      // D4G-12: digested over what it resolves to, exactly as the write will store it
      const t = await resolveIntakeTemplateCandidate(candidate.normalized, db);
      if (!t.ok) return reply.status(t.status).send(t.body);
      override = { template: t.template };
      candidateDigest = t.digest;
    }
    const actor = req.authCtx.userId ?? null;
    const computed = await computeRegression(db, subject, candidateDigest, override, live);
    const row = await db.transaction(async (tx) => {
      const r = await insertRun(tx, "preview", { ...computed, cases: computed.diff.cases, changed: computed.diff.changed }, actor);
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "decision_regression",
        objectId: r.id,
        detail: {
          phase: "previewed",
          subject,
          candidateDigest,
          baselineDigest: computed.baselineDigest,
          caseSetDigest: computed.caseSetDigest,
          cases: computed.diff.cases,
          changed: computed.diff.changed,
          changedCaseIds: computed.entries.map((e) => e.caseId),
        },
        effect: "allow",
        ruleId: "decision-regression-previewed",
        ruleChain: [],
        reason: `decision regression preview of a change to ${SUBJECT_COPY[subject]}: ${computed.diff.changed} of ${computed.diff.cases} golden case(s) would change`,
      });
      return r;
    });
    const settings = await loadOrgSettings(db);
    return reply.status(201).send(runView(row, await namesOf(db, [row.createdBy]), settings.decisionRegressionMaxAgeMinutes));
  });

  app.get("/v1/governance/decision-regression/runs", async (req) => {
    const q = runsQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(decisionRegressionRuns)
      .where(q.subject ? eq(decisionRegressionRuns.subject, q.subject) : undefined)
      .orderBy(desc(decisionRegressionRuns.createdAt), desc(decisionRegressionRuns.id))
      .limit(q.limit);
    const names = await namesOf(db, rows.map((r) => r.createdBy));
    const settings = await loadOrgSettings(db);
    return { runs: rows.map((r) => runView(r, names, settings.decisionRegressionMaxAgeMinutes, false)) };
  });

  app.get("/v1/governance/decision-regression/runs/:runId", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const [row] = await db.select().from(decisionRegressionRuns).where(eq(decisionRegressionRuns.id, runId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const settings = await loadOrgSettings(db);
    return runView(row, await namesOf(db, [row.createdBy]), settings.decisionRegressionMaxAgeMinutes);
  });

  app.get("/v1/governance/decision-regression/cases", async () => {
    const live = await loadLiveDecisionConfig(db);
    const cases = await loadRegressionCases(db);
    const rows = await db.select().from(decisionRegressionCases).where(isNull(decisionRegressionCases.retiredAt));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const names = await namesOf(db, rows.map((r) => r.createdBy));
    const run = runDecisionRegression(cases, live.config);
    const views: DecisionRegressionCaseView[] = run.results.map((res, i) => {
      const c = cases[i]!;
      const row = byId.get(c.id);
      return {
        id: c.id,
        source: c.source,
        label: c.label,
        answers: c.answers,
        expected: c.expected,
        fromUseCaseId: row?.fromUseCaseId ?? null,
        createdAt: row ? row.createdAt.toISOString() : null,
        createdByName: row?.createdBy ? (names.get(row.createdBy) ?? null) : null,
        outcome: res.outcome,
        unmetExpectation: res.unmetExpectation,
      };
    });
    return { cases: views, versions: decisionRuleVersions(), outcomeFields: DECISION_OUTCOME_FIELDS };
  });

  app.post("/v1/governance/decision-regression/cases", async (req, reply) => {
    const parsed = createDecisionRegressionCaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(422).send({ error: "invalid_case", issues: parsed.error.issues });
    const expected = expectedOutcomeSchema.safeParse(parsed.data.expected);
    if (!expected.success) return reply.status(422).send({ error: "invalid_expected_outcome", issues: expected.error.issues });
    let answers = parsed.data.answers ?? null;
    const fromUseCaseId = parsed.data.fromUseCaseId ?? null;
    if (fromUseCaseId) {
      if (answers) {
        return reply.status(422).send({
          error: "answers_and_use_case",
          detail: "a case from a use case snapshots that use case's answers; give one or the other",
        });
      }
      const [uc] = await db.select({ id: aiUseCases.id, intakeAnswers: aiUseCases.intakeAnswers }).from(aiUseCases).where(eq(aiUseCases.id, fromUseCaseId));
      if (!uc) return reply.status(404).send({ error: "unknown_use_case" });
      if (!uc.intakeAnswers) {
        return reply.status(422).send({
          error: "use_case_has_no_answers",
          detail: "this use case stored no Classify answers, so there is nothing to replay",
        });
      }
      answers = uc.intakeAnswers;
    }
    const actor = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      // a preview runs every live case: their number is bounded
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('decision_regression_cases'))`);
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(decisionRegressionCases)
        .where(isNull(decisionRegressionCases.retiredAt))) as [{ n: number }];
      if (Number(n) >= MAX_ACTIVE_OVERRIDE_CASES) return null;
      const [row] = await tx
        .insert(decisionRegressionCases)
        .values({
          source: "override",
          label: parsed.data.label,
          answers: answers!,
          expected: expected.data as Record<string, unknown>,
          createdBy: actor,
          fromUseCaseId,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "decision_regression",
        objectId: row!.id,
        detail: {
          phase: "case-created",
          caseId: row!.id,
          fromUseCaseId,
          expectedFields: expectedFields(expected.data as Partial<DecisionOutcome>),
          expected: expected.data,
          answersDigest: accountabilityDigest(answers),
        },
        effect: "allow",
        ruleId: "decision-regression-case-created",
        ruleChain: [],
        reason:
          `decision regression case added${fromUseCaseId ? ` from use case ${fromUseCaseId}` : ""}: ` +
          `it must keep ${expectedFields(expected.data as Partial<DecisionOutcome>).join(", ")}`,
      });
      return row!;
    });
    if (!out) {
      return reply.status(409).send({
        error: "too_many_cases",
        detail: `at most ${MAX_ACTIVE_OVERRIDE_CASES} reviewer cases may be live; retire one first`,
      });
    }
    const live = await loadLiveDecisionConfig(db);
    const outcome = decisionOutcomeFor(out.answers, live.config);
    const fields = expectedFields(out.expected as Partial<DecisionOutcome>);
    const unmet = runDecisionRegression(
      [{ id: out.id, label: out.label, source: "override", answers: out.answers, expected: out.expected as Partial<DecisionOutcome> }],
      live.config,
    ).results[0]!.unmetExpectation;
    const view: DecisionRegressionCaseView = {
      id: out.id,
      source: "override",
      label: out.label,
      answers: out.answers,
      expected: out.expected as Partial<DecisionOutcome>,
      fromUseCaseId: out.fromUseCaseId,
      createdAt: out.createdAt.toISOString(),
      createdByName: (await namesOf(db, [out.createdBy])).get(out.createdBy ?? "") ?? null,
      outcome,
      unmetExpectation: fields.length ? unmet : [],
    };
    return reply.status(201).send(view);
  });

  app.delete("/v1/governance/decision-regression/cases/:caseId", async (req, reply) => {
    const { caseId } = caseIdParam.parse(req.params);
    if (SHIPPED_GOLDEN_CASES.some((c) => c.id === caseId)) {
      return reply.status(409).send({
        error: "shipped_case",
        detail: "a shipped case is part of the code's golden set; it changes only with the code (golden-cases.ts)",
      });
    }
    if (!z.string().uuid().safeParse(caseId).success) return reply.status(404).send({ error: "not_found" });
    const actor = req.authCtx.userId ?? null;
    const retired = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(decisionRegressionCases)
        .set({ retiredAt: new Date() })
        .where(and(eq(decisionRegressionCases.id, caseId), isNull(decisionRegressionCases.retiredAt)))
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "decision_regression",
        objectId: row.id,
        detail: { phase: "case-retired", caseId: row.id, fromUseCaseId: row.fromUseCaseId },
        effect: "allow",
        ruleId: "decision-regression-case-retired",
        ruleChain: [],
        reason: `decision regression case ${row.id} retired: previews no longer run it`,
      });
      return row;
    });
    if (!retired) {
      const [exists] = await db.select({ id: decisionRegressionCases.id }).from(decisionRegressionCases).where(eq(decisionRegressionCases.id, caseId));
      return exists ? reply.status(409).send({ error: "already_retired" }) : reply.status(404).send({ error: "not_found" });
    }
    return { retired: true, id: retired.id, retiredAt: retired.retiredAt!.toISOString() };
  });

  // user-class: the use case's OWNER or an admin (in-handler)
  app.get("/v1/use-cases/:useCaseId/decision-records", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    const [uc] = await db.select({ id: aiUseCases.id, ownerUserId: aiUseCases.ownerUserId }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!uc) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== uc.ownerUserId) {
      return reply.status(403).send({ error: "forbidden", detail: "a use case's decision records are visible to its owner and to admins" });
    }
    const rows = await db
      .select()
      .from(useCaseDecisionRecords)
      .where(eq(useCaseDecisionRecords.useCaseId, useCaseId))
      .orderBy(desc(useCaseDecisionRecords.decidedAt), desc(useCaseDecisionRecords.createdAt));
    const names = await namesOf(db, rows.map((r) => r.decidedBy));
    const records: UseCaseDecisionRecordView[] = rows.map((r) => ({
      id: r.id,
      outcome: r.outcome,
      decidedAt: r.decidedAt.toISOString(),
      decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
      approvalId: r.approvalId,
      workflowInstanceId: r.workflowInstanceId,
      reviewPolicyVersion: r.reviewPolicyVersion,
      requiredTestsDigest: r.requiredTestsDigest,
      intakeTemplateId: r.intakeTemplateId,
      intakeTemplateName: r.intakeTemplateName,
      intakeDefinitionDigest: r.intakeDefinitionDigest,
      euAiActRulesetVersion: r.euAiActRulesetVersion,
      intakeAssistVersion: r.intakeAssistVersion,
      answersDigest: r.answersDigest,
    }));
    return { records, current: decisionRuleVersions() };
  });
}

/** the policy version a review-policy or required-tests write creates: one
 * past both the live row and every version ever recorded (versions are
 * append-only, so a re-created row never reuses a number) */
export async function nextReviewPolicyVersion(db: Writer, rowVersion: number | null): Promise<number> {
  const [m] = await asDb(db)
    .select({ max: sql<number | null>`max(${governanceReviewPolicyVersions.version})` })
    .from(governanceReviewPolicyVersions);
  return Math.max(rowVersion ?? 0, Number(m?.max ?? 0)) + 1;
}

/** append the version row of a review-policy configuration */
export async function appendReviewPolicyVersion(
  db: Writer,
  version: number,
  body: { roles: unknown[]; tiers: Record<string, unknown>; riskAcceptorUserIds: string[]; requiredTests: Record<string, unknown> },
  actorUserId: string | null,
): Promise<{ version: number; digest: string }> {
  const digest = accountabilityDigest(body);
  await asDb(db).insert(governanceReviewPolicyVersions).values({ version, body, digest, createdBy: actorUserId });
  return { version, digest };
}
