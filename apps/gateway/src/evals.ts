/**
 * ADR-0044 — the GATEWAY half of the agent evaluation & regression harness.
 *
 * Division of labour, drawn exactly where ADR-0042's guardrails already drew it:
 *
 *   `packages/shared/src/evals.ts`   the scorer registry, the aggregate math,
 *                                    and the gate decision. Pure — no db, no
 *                                    clock, no provider, no key.
 *   THIS FILE                        loads datasets, runs each case through the
 *                                    ONE governed dispatch core, persists runs
 *                                    and results, resolves the baseline, and
 *                                    owns the admin surface.
 *   `workflows.ts`                   binds a run to an `automated_check` and
 *                                    lets a REGRESSION fail that check through
 *                                    the EXISTING check_failed → blocked_on_check
 *                                    routing. No parallel failure mechanism.
 *
 * THE ONE THING THAT MAKES THIS A GOVERNANCE SURFACE AND NOT A TEST RUNNER
 *
 *   An eval dispatch is an ORDINARY dispatch. It goes through
 *   `executeGovernedDispatch`, which means the initiating user's entitlements
 *   are checked, the project's budget gate applies, §8.4 PII and ADR-0042
 *   guardrails apply to both phases, and every call lands in the SINGLE
 *   `usage_events` ledger attributed to the run's project. There is no
 *   "evaluation mode" that skips any of that. A harness that could reach a
 *   model the user cannot reach would be a governance hole shaped like a
 *   quality tool.
 *
 * WHAT IS AND IS NOT VERIFIED IN THIS BUILD (see the ADR-0044 amendment)
 *
 *   No model provider is connected in this environment. The deterministic
 *   scorers, the aggregate math, the gate decision, the persistence, the
 *   entitlement/guardrail/metering behaviour of the eval path, and the
 *   workflow-check routing are all exercised end to end against the in-memory
 *   mock provider. The MODEL-BACKED JUDGE below is wired and type-checked and
 *   its prompt/parse halves are unit-tested, but it has never scored a real
 *   model's output. Its judgment is therefore unproven; only its plumbing is.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
  agentGrants,
  and,
  asc,
  auditLog,
  count,
  desc,
  eq,
  evalCases,
  evalDatasets,
  evalResults,
  evalRuns,
  isNull,
  ne,
  sql,
  userAgentPolicies,
  users,
  type Db,
  type EvalCaseRow,
  type EvalDatasetRow,
  type EvalRunRow,
} from "@regulait/db";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import {
  aggregateEvalResults,
  buildJudgePrompt,
  createEvalCaseSchema,
  createEvalDatasetSchema,
  evalScorerConfigSchema,
  evalScorerRegistry,
  evaluateEvalGate,
  isDeterministicScorer,
  parseJudgeVerdict,
  scoreDeterministic,
  setEvalBaselineSchema,
  startEvalRunSchema,
  validateScorerConfig,
  type EvalAggregate,
  type EvalGateDecision,
  type EvalJudge,
  type EvalJudgeRequest,
  type EvalJudgeVerdict,
  type EvalScore,
  type EvalScorerConfig,
  type EvalScorerKind,
} from "@regulait/shared";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { assertProjectAttribution } from "./projects.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** how much of a model output is retained on a result row */
const OUTPUT_SNIPPET_MAX = 4000;

function hashPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The judge, behind an interface
// ---------------------------------------------------------------------------

/**
 * THE MODEL-BACKED JUDGE. It is an ordinary governed dispatch of a registry
 * agent — which is what makes it provider-agnostic (any registry entry, so
 * Claude / GPT / Gemini / a self-hosted custom_provider all work) and what
 * makes its cost visible in pillar 5 rather than hidden.
 *
 * Two deliberate properties:
 *  - `served` is passed EXPLICITLY, so routing never runs on a judge call. A
 *    cheaper judge is a different measuring instrument (ADR-0044 §6), and the
 *    optimizer must not be able to swap the ruler mid-measurement.
 *  - An unparseable verdict is an ERROR, never a silent pass. A judge that
 *    returns prose instead of JSON fails the case loudly.
 *
 * UNVERIFIED IN THIS BUILD: no provider is connected here, so this class has
 * never scored real model output. `buildJudgePrompt` and `parseJudgeVerdict`
 * are unit-tested; the model's judgment is not.
 */
export class ModelBackedJudge implements EvalJudge {
  readonly id: string;
  constructor(
    private readonly db: Db,
    private readonly dataKey: string | undefined,
    private readonly ctx: {
      judgeAgent: AgentRow;
      userId: string;
      projectId: string | null;
      threshold: number;
      evalRunId: string;
    },
  ) {
    this.id = `model:${ctx.judgeAgent.name}`;
  }

  async judge(req: EvalJudgeRequest): Promise<EvalJudgeVerdict> {
    const prompt = buildJudgePrompt(req, this.ctx.threshold);
    const outcome = await executeGovernedDispatch(this.db, this.dataKey, {
      userId: this.ctx.userId,
      served: this.ctx.judgeAgent,
      requestedAgentId: this.ctx.judgeAgent.id,
      // no routing counterfactual: the judge tier is PINNED per deployment
      baseline: null,
      input: prompt,
      maxTokens: 1024,
      projectId: this.ctx.projectId,
      detail: { purpose: "eval-judge", evalRunId: this.ctx.evalRunId },
    });
    if (!outcome.ok) {
      throw new Error(`judge dispatch failed: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
    }
    const parsed = parseJudgeVerdict(outcome.result.outputText, this.ctx.threshold);
    if (!parsed.ok) throw new Error(`judge verdict unusable: ${parsed.error}`);
    return parsed.verdict;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface EvalRunOptions {
  datasetId: string;
  /** the agent under test */
  agentId: string;
  /** whose entitlements, whose budget, whose audit trail */
  userId: string;
  trigger: "manual" | "workflow" | "scheduled";
  mode?: string;
  judgeAgentId?: string | null | undefined;
  projectId?: string | null | undefined;
  tolerance?: number;
  minScore?: number | null | undefined;
  minPassRate?: number | null | undefined;
  /** pin the comparison to a specific prior run */
  baselineRunId?: string | null | undefined;
  /** true = a missing baseline FAILS the gate instead of standing as first reference */
  requireBaseline?: boolean;
  workflow?: { instanceId: string; stageId: string; checkName: string } | null | undefined;
  note?: string | null | undefined;
  /**
   * ADR-0057 — THE ORIGIN TAG. Stamped onto `detail.purpose` of every dispatch
   * this run makes and onto the run's audit row, so adversarial red-team
   * traffic is separable from ordinary evaluation traffic in the pillar-5 cost
   * dashboard and in anomaly detection. Defaults to `"eval"`, which is exactly
   * what every pre-ADR-0057 caller already emitted — the tag changes no
   * behaviour, only the label the ledger carries.
   */
  purpose?: string | undefined;
  /** extra key/values merged into each dispatch's `detail` (the red-team run
   * id, so a transcript can be traced back to the probe that produced it) */
  originDetail?: Record<string, unknown> | undefined;
  /**
   * TEST SEAM (and future extension point): supply the judge implementation.
   * Absent = a `ModelBackedJudge` built from `judgeAgentId`, i.e. the real,
   * model-backed path. A test injects a deterministic stub here to prove the
   * wiring without a provider.
   */
  judge?: EvalJudge | null | undefined;
}

export type EvalRunOutcome =
  | {
      ok: true;
      run: EvalRunRow;
      aggregate: EvalAggregate;
      gate: EvalGateDecision;
      baseline: EvalRunRow | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      decision?: AgentDecision;
    };

interface CaseScore {
  caseId: string;
  scorerKind: EvalScorerKind;
  score: number;
  passed: boolean;
  latencyMs: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  outputText: string | null;
  judgeRationale: string | null;
  error: string | null;
  detail: Record<string, unknown>;
}

/** the entitlement inputs, loaded once for both the agent under test and the
 * judge — the SAME evaluateAgent path an ordinary invoke takes */
async function agentDecider(db: Db, userId: string) {
  const [grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return (agent: AgentRow, mode: string): AgentDecision =>
    evaluateAgent({
      userId,
      agent: {
        id: agent.id,
        name: agent.name,
        tier: agent.tier,
        enabled: agent.enabled,
        modes: agent.modes ?? null,
      },
      mode,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocations,
      ceilingTier,
    });
}

/**
 * ADR-0044 §4: "Baseline = the last passing run on the same dataset version for
 * that agent", with an admin-pinned override. Precedence, strictest first:
 *   1. an explicitly named run (the caller pinned the comparison),
 *   2. the admin-pinned `is_baseline` run for this (dataset version, agent),
 *   3. the most recent completed run that did not itself fail its gate.
 * A run is never compared against itself.
 */
export async function resolveBaselineRun(
  db: Db,
  opts: {
    datasetId: string;
    datasetVersion: number;
    agentId: string;
    explicitRunId?: string | null | undefined;
    excludeRunId?: string | null | undefined;
  },
): Promise<EvalRunRow | null> {
  if (opts.explicitRunId) {
    const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, opts.explicitRunId));
    return row && row.status === "completed" ? row : null;
  }
  const scope = and(
    eq(evalRuns.datasetId, opts.datasetId),
    eq(evalRuns.datasetVersion, opts.datasetVersion),
    eq(evalRuns.agentId, opts.agentId),
    eq(evalRuns.status, "completed"),
    opts.excludeRunId ? ne(evalRuns.id, opts.excludeRunId) : undefined,
  );
  const [pinned] = await db
    .select()
    .from(evalRuns)
    .where(and(scope, eq(evalRuns.isBaseline, true)))
    .limit(1);
  if (pinned) return pinned;
  const [latest] = await db
    .select()
    .from(evalRuns)
    .where(and(scope, ne(evalRuns.gatePassed, false)))
    .orderBy(desc(evalRuns.startedAt))
    .limit(1);
  return latest ?? null;
}

function aggregateOf(run: EvalRunRow): EvalAggregate {
  return {
    cases: run.cases,
    passedCases: run.passedCases,
    failedCases: run.cases - run.passedCases,
    meanScore: run.meanScore ?? 0,
    passRate: run.passRate ?? 0,
  };
}

/** dataset default + per-case override, resolved once per case */
function resolveScorer(
  dataset: EvalDatasetRow,
  c: EvalCaseRow,
): { kind: EvalScorerKind; config: EvalScorerConfig } {
  const kind = (c.scorerKind ?? dataset.scorerKind) as EvalScorerKind;
  const raw = c.scorerConfig ?? dataset.scorerConfig ?? {};
  const parsed = evalScorerConfigSchema.safeParse(raw);
  return { kind, config: parsed.success ? parsed.data : {} };
}

/**
 * THE RUNNER. Executes every case of a pinned dataset version through the
 * governed dispatch core as the initiating user, scores each, persists a
 * result row, then computes the aggregate and the delta against the resolved
 * baseline. That delta IS the regression signal the workflow check blocks on.
 */
export async function runEvalSuite(
  db: Db,
  dataKey: string | undefined,
  opts: EvalRunOptions,
): Promise<EvalRunOutcome> {
  const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, opts.datasetId));
  if (!dataset) return { ok: false, status: 404, error: "unknown_dataset" };

  const [agent] = await db.select().from(agents).where(eq(agents.id, opts.agentId));
  if (!agent) return { ok: false, status: 404, error: "unknown_agent" };

  const mode = opts.mode ?? "execute";
  // ADR-0057: the origin tag rides every dispatch detail and the run's audit
  // row. "eval" is the pre-ADR-0057 value, so an untagged caller is unchanged.
  const purpose = opts.purpose ?? "eval";
  const originDetail = opts.originDetail ?? {};
  const decide = await agentDecider(db, opts.userId);

  // ENTITLEMENT, FIRST AND UNCONDITIONALLY. An eval is not a side channel: a
  // user who may not invoke this agent may not measure it either, and the
  // denial is the ordinary AgentDecision shape an invoke would return.
  const decision = decide(agent as AgentRow, mode);
  if (decision.effect !== "allow") {
    await db.insert(auditLog).values({
      userId: opts.userId,
      objectType: "eval_run",
      objectId: dataset.id,
      detail: {
        phase: "agent-entitlement",
        purpose,
        ...originDetail,
        agentId: agent.id,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
        mode,
        ...(opts.workflow ? { workflowInstanceId: opts.workflow.instanceId, stageId: opts.workflow.stageId } : {}),
      },
      effect: "deny",
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });
    return { ok: false, status: 403, error: "agent_not_entitled", decision };
  }

  // The judge, if one is named, is ALSO a governed dispatch on this user's
  // behalf — so it takes the identical entitlement check.
  let judgeAgent: AgentRow | null = null;
  if (opts.judgeAgentId) {
    const [ja] = await db.select().from(agents).where(eq(agents.id, opts.judgeAgentId));
    if (!ja) return { ok: false, status: 404, error: "unknown_judge_agent" };
    const jd = decide(ja as AgentRow, mode);
    if (jd.effect !== "allow") {
      await db.insert(auditLog).values({
        userId: opts.userId,
        objectType: "eval_run",
        objectId: dataset.id,
        detail: { phase: "judge-entitlement", purpose, ...originDetail, judgeAgentId: ja.id, mode },
        effect: "deny",
        ruleId: jd.ruleId,
        ruleChain: jd.ruleChain,
        reason: jd.reason,
      });
      return { ok: false, status: 403, error: "judge_not_entitled", decision: jd };
    }
    judgeAgent = ja as AgentRow;
  }

  const cases = await db
    .select()
    .from(evalCases)
    .where(and(eq(evalCases.datasetId, dataset.id), eq(evalCases.datasetVersion, dataset.version)))
    .orderBy(asc(evalCases.createdAt), asc(evalCases.id));

  const tolerance = opts.tolerance ?? 0.05;
  const [run] = await db
    .insert(evalRuns)
    .values({
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      agentId: agent.id,
      customProviderId: agent.customProviderId ?? null,
      agentName: agent.name,
      model: agent.model,
      tier: agent.tier,
      systemPromptHash: hashPrompt(agent.systemPrompt),
      judgeAgentId: judgeAgent?.id ?? null,
      trigger: opts.trigger,
      status: "running",
      mode,
      initiatedByUserId: opts.userId,
      projectId: opts.projectId ?? null,
      workflowInstanceId: opts.workflow?.instanceId ?? null,
      workflowStageId: opts.workflow?.stageId ?? null,
      workflowCheckName: opts.workflow?.checkName ?? null,
      tolerance,
      minScore: opts.minScore ?? null,
      minPassRate: opts.minPassRate ?? null,
      note: opts.note ?? null,
    })
    .returning();

  // The judge implementation is chosen ONCE per run and recorded on it, so a
  // score can never be mistaken for a model's opinion when no model produced
  // it (`judge_impl` is 'model:<agent>' only for the real path).
  const judge: EvalJudge | null =
    opts.judge ??
    (judgeAgent
      ? new ModelBackedJudge(db, dataKey, {
          judgeAgent,
          userId: opts.userId,
          projectId: opts.projectId ?? null,
          threshold: 1,
          evalRunId: run!.id,
        })
      : null);

  const scores: CaseScore[] = [];
  for (const c of cases) {
    const { kind, config } = resolveScorer(dataset, c);
    const started = Date.now();
    // THE GOVERNED DISPATCH. `served` is passed explicitly — the harness
    // measures the agent it was asked to measure, never a routed substitute.
    const outcome = await executeGovernedDispatch(db, dataKey, {
      userId: opts.userId,
      served: agent as AgentRow,
      requestedAgentId: agent.id,
      baseline: null,
      input: c.input,
      maxTokens: 2048,
      projectId: opts.projectId ?? null,
      detail: {
        purpose,
        ...originDetail,
        evalRunId: run!.id,
        evalCaseId: c.id,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
      },
    });
    const latencyMs = Date.now() - started;

    if (!outcome.ok) {
      // A blocked or refused dispatch is a FAILED case, not a skipped one. A
      // guardrail that stops an eval prompt is a real signal about the agent's
      // configuration and must show up as a zero, never as an absence.
      scores.push({
        caseId: c.id,
        scorerKind: kind,
        score: 0,
        passed: false,
        latencyMs,
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        outputText: null,
        judgeRationale: null,
        error: `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}`,
        detail: { dispatch: "failed", status: outcome.status },
      });
      continue;
    }

    const output = outcome.result.outputText;
    let scored: EvalScore;
    let rationale: string | null = null;
    let caseError: string | null = null;
    if (isDeterministicScorer(kind)) {
      scored = scoreDeterministic({
        kind: kind as Exclude<EvalScorerKind, "llm_as_judge">,
        expected: c.expected ?? null,
        output,
        config,
      });
    } else if (!judge) {
      // No judge configured for a judge-scored case: fail LOUDLY. Passing it
      // would mean an unmeasured case silently counting as evidence.
      scored = { score: 0, passed: false, detail: { reason: "no judge configured for an llm_as_judge case" } };
      caseError = "no_judge_configured";
    } else {
      try {
        const verdict = await judge.judge({
          caseInput: c.input,
          expected: c.expected ?? null,
          rubric: c.rubric ?? null,
          output,
          instructions: config.instructions ?? null,
        });
        scored = { score: verdict.score, passed: verdict.passed, detail: { judge: judge.id } };
        rationale = verdict.rationale;
      } catch (e) {
        scored = { score: 0, passed: false, detail: { judge: judge.id, failed: true } };
        caseError = `judge_failed: ${(e as Error).message}`;
      }
    }

    scores.push({
      caseId: c.id,
      scorerKind: kind,
      score: scored.score,
      passed: scored.passed,
      latencyMs,
      costUsd: outcome.result.costUsd,
      inputTokens: outcome.result.usage.inputTokens,
      outputTokens: outcome.result.usage.outputTokens,
      outputText: output.slice(0, OUTPUT_SNIPPET_MAX),
      judgeRationale: rationale,
      error: caseError,
      detail: scored.detail,
    });
  }

  if (scores.length > 0) {
    await db.insert(evalResults).values(
      scores.map((s) => ({
        runId: run!.id,
        caseId: s.caseId,
        scorerKind: s.scorerKind,
        score: s.score,
        passed: s.passed,
        latencyMs: s.latencyMs,
        costUsd: s.costUsd,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        outputText: s.outputText,
        judgeRationale: s.judgeRationale,
        error: s.error,
        detail: s.detail,
      })),
    );
  }

  const aggregate = aggregateEvalResults(scores);
  const baseline = await resolveBaselineRun(db, {
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    agentId: agent.id,
    explicitRunId: opts.baselineRunId ?? null,
    excludeRunId: run!.id,
  });
  const gate = evaluateEvalGate({
    current: aggregate,
    baseline: baseline ? aggregateOf(baseline) : null,
    tolerance,
    minScore: opts.minScore ?? null,
    minPassRate: opts.minPassRate ?? null,
    requireBaseline: opts.requireBaseline ?? false,
  });

  const costUsd = Number(scores.reduce((a, s) => a + (s.costUsd ?? 0), 0).toFixed(6));
  const [finished] = await db
    .update(evalRuns)
    .set({
      status: "completed",
      cases: aggregate.cases,
      passedCases: aggregate.passedCases,
      meanScore: aggregate.meanScore,
      passRate: aggregate.passRate,
      costUsd,
      inputTokens: scores.reduce((a, s) => a + s.inputTokens, 0),
      outputTokens: scores.reduce((a, s) => a + s.outputTokens, 0),
      baselineRunId: baseline?.id ?? null,
      scoreDelta: gate.scoreDelta,
      passRateDelta: gate.passRateDelta,
      gatePassed: gate.passed,
      regression: gate.regression,
      gateReason: gate.reason,
      judgeImpl: judge?.id ?? null,
      finishedAt: new Date(),
    })
    .where(eq(evalRuns.id, run!.id))
    .returning();

  // ONE audit row per run, into the SINGLE audit log, with object_type
  // 'eval_run' (a plain-text column — no DDL, the ADR-0024/0034 pattern).
  await db.insert(auditLog).values({
    userId: opts.userId,
    objectType: "eval_run",
    objectId: finished!.id,
    detail: {
      phase: "eval",
      purpose,
      ...originDetail,
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      systemPromptHash: finished!.systemPromptHash,
      trigger: opts.trigger,
      judgeAgentId: judgeAgent?.id ?? null,
      judgeImpl: judge?.id ?? null,
      cases: aggregate.cases,
      meanScore: aggregate.meanScore,
      passRate: aggregate.passRate,
      baselineRunId: baseline?.id ?? null,
      scoreDelta: gate.scoreDelta,
      regression: gate.regression,
      costUsd,
      ...(opts.workflow ? { workflowInstanceId: opts.workflow.instanceId, stageId: opts.workflow.stageId, check: opts.workflow.checkName } : {}),
    },
    effect: gate.passed ? "allow" : "deny",
    ruleId: gate.passed ? "eval-run-passed" : gate.regression ? "eval-regression" : "eval-run-failed",
    ruleChain: [],
    reason: gate.reason,
  });

  return { ok: true, run: finished!, aggregate, gate, baseline };
}

// ---------------------------------------------------------------------------
// Immutability: a dataset version referenced by a run cannot change
// ---------------------------------------------------------------------------

export async function datasetIsFrozen(db: Db, dataset: EvalDatasetRow): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(evalRuns)
    .where(and(eq(evalRuns.datasetId, dataset.id), eq(evalRuns.datasetVersion, dataset.version)));
  return (row?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// ADR-0044 §5 — THE DRIFT SWEEP
// ---------------------------------------------------------------------------

export const EVAL_DRIFT_SWEEP_NOTE =
  "The sweep re-runs every PINNED BASELINE pair (dataset version × agent) as the user who pinned it — " +
  "so it never exceeds that person's entitlements and never mints an identity of its own. A pair whose " +
  "baseline has no surviving initiator is SKIPPED and said so, rather than run as somebody else. " +
  "Regression is decided by the ordinary runner against the ordinary baseline; this only decides WHEN " +
  "the comparison happens. Driven by ADR-0064's scheduler when it is on, and by this endpoint otherwise.";

export interface EvalDriftSweepResult {
  /** pairs the sweep actually re-ran */
  ran: Array<{
    datasetId: string;
    agentId: string;
    runId: string;
    regression: boolean;
    scoreDelta: number | null;
  }>;
  skipped: Array<{ datasetId: string; agentId: string | null; reason: string }>;
}

/**
 * ONE PASS of the ADR-0044 §5 drift detector.
 *
 * ADR-0044 shipped the `scheduled` trigger and then disclosed, honestly, that
 * nothing drives it — §5 was the one part of that ADR that did not ship, and it
 * did not ship because there was no scheduler. This is the driver ADR-0064 lets
 * us write, and it deliberately adds NO measurement logic: it decides WHICH
 * pairs to re-measure and hands each to `runEvalSuite` — the same function
 * `POST /v1/evals/runs` calls. Regression, the baseline comparison and the gate
 * are all computed by that one runner.
 *
 * WHOSE AUTHORITY. A pinned baseline names the person who pinned/ran it. The
 * sweep runs as THAT user, so an eval dispatch made by the scheduler is subject
 * to exactly the entitlements, budget and audit attribution a manual run by that
 * person would be. The scheduler has no identity of its own and never
 * substitutes one — a pair whose initiator is gone is skipped with a reason,
 * which is strictly better than quietly running it as an admin.
 */
export async function runEvalDriftSweep(
  db: Db,
  dataKey: string | undefined,
): Promise<EvalDriftSweepResult> {
  const pinned = await db
    .select()
    .from(evalRuns)
    .where(and(eq(evalRuns.isBaseline, true), eq(evalRuns.status, "completed")))
    .orderBy(asc(evalRuns.startedAt));

  const ran: EvalDriftSweepResult["ran"] = [];
  const skipped: EvalDriftSweepResult["skipped"] = [];
  const seen = new Set<string>();

  for (const base of pinned) {
    if (!base.agentId) {
      skipped.push({ datasetId: base.datasetId, agentId: null, reason: "baseline has no agent" });
      continue;
    }
    const key = `${base.datasetId}:${base.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!base.initiatedByUserId) {
      skipped.push({
        datasetId: base.datasetId,
        agentId: base.agentId,
        reason:
          "the baseline's initiating user is gone — the sweep will not run an eval as somebody else, " +
          "so re-pin a baseline under a current user to resume drift detection for this pair",
      });
      continue;
    }

    const outcome = await runEvalSuite(db, dataKey, {
      datasetId: base.datasetId,
      agentId: base.agentId,
      userId: base.initiatedByUserId,
      trigger: "scheduled",
      tolerance: base.tolerance,
      minScore: base.minScore,
      minPassRate: base.minPassRate,
      note: "ADR-0044 §5 drift sweep",
    });
    if (!outcome.ok) {
      skipped.push({
        datasetId: base.datasetId,
        agentId: base.agentId,
        reason: `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      });
      continue;
    }
    ran.push({
      datasetId: base.datasetId,
      agentId: base.agentId,
      runId: outcome.run.id,
      regression: outcome.run.regression === true,
      scoreDelta: outcome.run.scoreDelta,
    });
  }
  return { ran, skipped };
}

// ---------------------------------------------------------------------------
// Admin + run API
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const caseParam = z.object({ id: z.string().uuid(), caseId: z.string().uuid() });

export interface EvalRouteOptions {
  dataKey?: string;
}

export function registerEvalRoutes(app: FastifyInstance, db: Db, opts: EvalRouteOptions = {}) {
  /** the scorer registry, verbatim from the code — each entry's honest `limits`
   * string rendered next to it in the admin screen */
  app.get("/v1/evals/scorers", async () => ({
    scorers: evalScorerRegistry(),
    note:
      "Six of the seven scorers are pure functions — same output, same score, no cost, no variance. " +
      "llm_as_judge is a governed model call: it costs tokens, it varies run to run, and the judge is " +
      "itself an agent that can regress. Build a BLOCKING gate on the deterministic ones and treat the " +
      "judge as corroboration.",
  }));

  /** datasets, newest version of each name first, with case counts and the
   * frozen flag an editor needs before it offers an edit button */
  app.get("/v1/evals/datasets", async () => {
    const rows = await db.select().from(evalDatasets).orderBy(asc(evalDatasets.name), desc(evalDatasets.version));
    const counts = await db
      .select({ datasetId: evalCases.datasetId, n: sql<number>`count(*)::int` })
      .from(evalCases)
      .groupBy(evalCases.datasetId);
    const runCounts = await db
      .select({ datasetId: evalRuns.datasetId, n: sql<number>`count(*)::int` })
      .from(evalRuns)
      .groupBy(evalRuns.datasetId);
    const caseMap = new Map(counts.map((c) => [c.datasetId, c.n]));
    const runMap = new Map(runCounts.map((c) => [c.datasetId, c.n]));
    return {
      datasets: rows.map((d) => ({
        ...d,
        caseCount: caseMap.get(d.id) ?? 0,
        runCount: runMap.get(d.id) ?? 0,
        frozen: (runMap.get(d.id) ?? 0) > 0,
      })),
      note: "A dataset version freezes the moment a run scores against it. Editing cases mints the next version instead — a gate result is meaningless if the ruler can move underneath it.",
    };
  });

  app.post("/v1/evals/datasets", async (req, reply) => {
    const body = createEvalDatasetSchema.parse(req.body);
    const [existing] = await db
      .select({ n: count() })
      .from(evalDatasets)
      .where(eq(evalDatasets.name, body.name));
    if ((existing?.n ?? 0) > 0) return reply.status(409).send({ error: "dataset_name_taken" });
    const [row] = await db
      .insert(evalDatasets)
      .values({
        name: body.name,
        version: 1,
        note: body.note ?? null,
        scorerKind: body.scorerKind,
        scorerConfig: body.scorerConfig,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/evals/datasets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_dataset" });
    const cases = await db
      .select()
      .from(evalCases)
      .where(and(eq(evalCases.datasetId, dataset.id), eq(evalCases.datasetVersion, dataset.version)))
      .orderBy(asc(evalCases.createdAt), asc(evalCases.id));
    const versions = await db
      .select({ id: evalDatasets.id, version: evalDatasets.version })
      .from(evalDatasets)
      .where(eq(evalDatasets.name, dataset.name))
      .orderBy(desc(evalDatasets.version));
    return { dataset, cases, versions, frozen: await datasetIsFrozen(db, dataset) };
  });

  app.post("/v1/evals/datasets/:id/cases", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = createEvalCaseSchema.parse(req.body);
    const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_dataset" });
    if (await datasetIsFrozen(db, dataset)) {
      return reply.status(409).send({
        error: "dataset_version_frozen",
        detail: `version ${dataset.version} of '${dataset.name}' has already been scored by a run and is immutable — POST /v1/evals/datasets/${dataset.id}/versions to mint the next version, then edit that`,
      });
    }
    const kind = (body.scorerKind ?? dataset.scorerKind) as EvalScorerKind;
    const cfg = evalScorerConfigSchema.parse(body.scorerConfig ?? dataset.scorerConfig ?? {});
    // A scorer that cannot discriminate is refused HERE, at authoring time —
    // an eval suite where no case can fail is theatre, and it is far cheaper to
    // reject it now than to explain a green gate later.
    const bad = validateScorerConfig(kind, cfg, body.expected ?? null);
    if (bad) return reply.status(422).send({ error: "unusable_scorer_config", detail: bad });
    const [row] = await db
      .insert(evalCases)
      .values({
        datasetId: dataset.id,
        datasetVersion: dataset.version,
        input: body.input,
        expected: (body.expected ?? null) as never,
        rubric: (body.rubric ?? null) as never,
        tags: body.tags,
        scorerKind: body.scorerKind ?? null,
        scorerConfig: body.scorerConfig ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete("/v1/evals/datasets/:id/cases/:caseId", async (req, reply) => {
    const { id, caseId } = caseParam.parse(req.params);
    const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_dataset" });
    if (await datasetIsFrozen(db, dataset)) {
      return reply.status(409).send({ error: "dataset_version_frozen" });
    }
    const [row] = await db.delete(evalCases).where(eq(evalCases.id, caseId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_case" });
    return { deleted: true };
  });

  /** Mint version N+1 of a dataset, COPYING the current version's cases. This
   * is the only way to change a frozen dataset — the old version keeps standing
   * behind every run that scored against it. */
  app.post("/v1/evals/datasets/:id/versions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_dataset" });
    const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body ?? {});
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${evalDatasets.version}), 0)::int` })
      .from(evalDatasets)
      .where(eq(evalDatasets.name, dataset.name));
    const [next] = await db
      .insert(evalDatasets)
      .values({
        name: dataset.name,
        version: (maxRow?.max ?? dataset.version) + 1,
        note: body.note ?? dataset.note,
        scorerKind: dataset.scorerKind,
        scorerConfig: dataset.scorerConfig,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    const cases = await db
      .select()
      .from(evalCases)
      .where(and(eq(evalCases.datasetId, dataset.id), eq(evalCases.datasetVersion, dataset.version)));
    if (cases.length > 0) {
      await db.insert(evalCases).values(
        cases.map((c) => ({
          datasetId: next!.id,
          datasetVersion: next!.version,
          input: c.input,
          expected: c.expected as never,
          rubric: c.rubric as never,
          tags: c.tags,
          scorerKind: c.scorerKind,
          scorerConfig: c.scorerConfig,
        })),
      );
    }
    return reply.status(201).send({ dataset: next, copiedCases: cases.length });
  });

  /**
   * TRIGGER A RUN. Deliberately NOT admin-only (it is in app.ts's
   * NON_ADMIN_ROUTES): the gate is the caller's own agent entitlement, checked
   * inside the runner exactly as an invoke would check it. A user who cannot
   * invoke the agent cannot evaluate it either.
   */
  app.post("/v1/evals/runs", async (req, reply) => {
    const body = startEvalRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_run_evals" });
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }
    const outcome = await runEvalSuite(db, opts.dataKey, {
      datasetId: body.datasetId,
      agentId: body.agentId,
      userId,
      trigger: "manual",
      mode: body.mode,
      judgeAgentId: body.judgeAgentId ?? null,
      projectId: body.projectId ?? null,
      tolerance: body.tolerance,
      minScore: body.minScore ?? null,
      minPassRate: body.minPassRate ?? null,
      baselineRunId: body.baselineRunId ?? null,
      note: body.note ?? null,
    });
    if (!outcome.ok) {
      return reply.status(outcome.status).send({
        error: outcome.error,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        ...(outcome.decision ? { decision: outcome.decision } : {}),
      });
    }
    return reply.status(201).send({
      run: outcome.run,
      aggregate: outcome.aggregate,
      gate: outcome.gate,
      baselineRunId: outcome.baseline?.id ?? null,
    });
  });

  app.get("/v1/evals/runs", async (req) => {
    const q = z
      .object({
        datasetId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const where = and(
      q.datasetId ? eq(evalRuns.datasetId, q.datasetId) : undefined,
      q.agentId ? eq(evalRuns.agentId, q.agentId) : undefined,
    );
    const rows = await db
      .select()
      .from(evalRuns)
      .where(where)
      .orderBy(desc(evalRuns.startedAt))
      .limit(q.limit);
    const names = await db.select({ id: evalDatasets.id, name: evalDatasets.name }).from(evalDatasets);
    const nameMap = new Map(names.map((n) => [n.id, n.name]));
    return { runs: rows.map((r) => ({ ...r, datasetName: nameMap.get(r.datasetId) ?? null })) };
  });

  /** a run, its per-case results, and the CASE-LEVEL DIFF against the baseline
   * — "which cases got worse" is the question a regression report has to answer,
   * and an aggregate alone cannot */
  app.get("/v1/evals/runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_run" });
    const results = await db
      .select()
      .from(evalResults)
      .where(eq(evalResults.runId, run.id))
      .orderBy(asc(evalResults.createdAt), asc(evalResults.id));
    const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, run.datasetId));
    const cases = await db
      .select()
      .from(evalCases)
      .where(and(eq(evalCases.datasetId, run.datasetId), eq(evalCases.datasetVersion, run.datasetVersion)));
    const caseMap = new Map(cases.map((c) => [c.id, c]));
    let baseline: EvalRunRow | null = null;
    let diff: Array<{
      caseId: string | null;
      input: string | null;
      score: number;
      baselineScore: number | null;
      delta: number | null;
      passed: boolean;
      baselinePassed: boolean | null;
      regressed: boolean;
    }> = [];
    if (run.baselineRunId) {
      const [b] = await db.select().from(evalRuns).where(eq(evalRuns.id, run.baselineRunId));
      baseline = b ?? null;
      const baseResults = b
        ? await db.select().from(evalResults).where(eq(evalResults.runId, b.id))
        : [];
      const baseMap = new Map(baseResults.map((r) => [r.caseId, r]));
      diff = results.map((r) => {
        const prior = r.caseId ? baseMap.get(r.caseId) : undefined;
        return {
          caseId: r.caseId,
          input: r.caseId ? (caseMap.get(r.caseId)?.input ?? null) : null,
          score: r.score,
          baselineScore: prior?.score ?? null,
          delta: prior ? Number((r.score - prior.score).toFixed(4)) : null,
          passed: r.passed,
          baselinePassed: prior?.passed ?? null,
          regressed: prior ? r.score < prior.score : false,
        };
      });
    }
    return {
      run,
      dataset: dataset ?? null,
      results: results.map((r) => ({
        ...r,
        input: r.caseId ? (caseMap.get(r.caseId)?.input ?? null) : null,
        expected: r.caseId ? (caseMap.get(r.caseId)?.expected ?? null) : null,
      })),
      baseline,
      diff,
    };
  });

  /** pin (or unpin) a run as THE baseline for its (dataset version, agent).
   * The DB permits at most one pinned baseline per triple, so this replaces
   * rather than accumulates. */
  app.post("/v1/evals/runs/:id/baseline", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = setEvalBaselineSchema.parse(req.body ?? {});
    const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_run" });
    if (body.isBaseline && run.status !== "completed") {
      return reply.status(409).send({ error: "run_not_completed" });
    }
    if (body.isBaseline) {
      await db
        .update(evalRuns)
        .set({ isBaseline: false })
        .where(
          and(
            eq(evalRuns.datasetId, run.datasetId),
            eq(evalRuns.datasetVersion, run.datasetVersion),
            run.agentId ? eq(evalRuns.agentId, run.agentId) : isNull(evalRuns.agentId),
            eq(evalRuns.isBaseline, true),
          ),
        );
    }
    const [updated] = await db
      .update(evalRuns)
      .set({ isBaseline: body.isBaseline })
      .where(eq(evalRuns.id, run.id))
      .returning();
    await db.insert(auditLog).values({
      // the bootstrap admin has no user row; NIL_UUID is the house convention
      // for "the deployment itself acted" (see guardrails.ts)
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "eval_run",
      objectId: run.id,
      detail: { phase: "baseline", isBaseline: body.isBaseline, agentId: run.agentId, datasetId: run.datasetId, datasetVersion: run.datasetVersion },
      effect: "allow",
      ruleId: body.isBaseline ? "eval-baseline-set" : "eval-baseline-cleared",
      ruleChain: [],
      reason: body.isBaseline
        ? `run ${run.id} pinned as the baseline for '${run.agentName}' on dataset version ${run.datasetVersion} — every later run is measured against it`
        : `run ${run.id} unpinned as baseline`,
    });
    return { run: updated };
  });

  /**
   * ADR-0044 §5 — THE DRIFT SWEEP, as an ENDPOINT. ADR-0064's in-process
   * scheduler drives the SAME function when it is switched on; this endpoint is
   * the manual/on-demand door to it. Admin-only through the default gate: the
   * sweep re-runs every pinned baseline in the deployment, which is org-wide
   * authority even though each individual run executes under the entitlements
   * of whoever pinned it.
   */
  app.post("/v1/evals/drift-sweep", async () => {
    const result = await runEvalDriftSweep(db, opts.dataKey);
    return { ...result, note: EVAL_DRIFT_SWEEP_NOTE };
  });

  /** who ran what, most recently — the drift view the admin screen opens on */
  app.get("/v1/evals/summary", async () => {
    const rows = await db
      .select()
      .from(evalRuns)
      .orderBy(desc(evalRuns.startedAt))
      .limit(200);
    const userRows = await db.select({ id: users.id, email: users.email }).from(users);
    const emails = new Map(userRows.map((u) => [u.id, u.email]));
    const regressions = rows.filter((r) => r.regression === true).length;
    return {
      runs: rows.length,
      regressions,
      failed: rows.filter((r) => r.gatePassed === false).length,
      totalCostUsd: Number(rows.reduce((a, r) => a + r.costUsd, 0).toFixed(6)),
      recent: rows.slice(0, 25).map((r) => ({
        id: r.id,
        agentName: r.agentName,
        model: r.model,
        trigger: r.trigger,
        meanScore: r.meanScore,
        passRate: r.passRate,
        scoreDelta: r.scoreDelta,
        gatePassed: r.gatePassed,
        regression: r.regression,
        isBaseline: r.isBaseline,
        startedAt: r.startedAt,
        by: r.initiatedByUserId ? (emails.get(r.initiatedByUserId) ?? null) : null,
      })),
    };
  });
}
