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
  externalScorers,
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
import { isModelProviderKind } from "@regulait/model-provider";
import {
  SCORING_SEMANTICS_CHANGELOG,
  SCORING_SEMANTICS_VERSION,
  aggregateEvalResults,
  buildGroundednessJudgePrompt,
  buildJudgePrompt,
  classifyDispatchFailure,
  createEvalCaseSchema,
  createEvalDatasetSchema,
  evalScorerConfigSchema,
  evalScorerRegistry,
  evaluateEvalGate,
  externalScorerAvailabilityFor,
  externalScorerMethod,
  EXTERNAL_SCORER_DISCLOSURE,
  isDeterministicScorer,
  isJudgeBackedScorer,
  judgeAvailabilityFor,
  parseGroundednessVerdict,
  parseJudgeVerdict,
  scoreDeterministic,
  scoringSemanticsMismatchReason,
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
  type JudgeBackedScorerKind,
} from "@regulait/shared";
import {
  agentProviderToken,
  configuredProviders,
  executeGovernedDispatch,
  type AgentRow,
} from "./agents-connectors.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { beginTrace, childContext, closeSpan, finishTrace, openSpan } from "./tracing.js";
import { assertProjectAttribution } from "./projects.js";
import {
  callExternalScorer,
  resolveExternalScorersByName,
  type ResolvedExternalScorer,
} from "./external-scorers.js";

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
    // ADR-0067: the metric decides the prompt and the parser. A groundedness
    // judgement is a different question from ADR-0044's reference-comparison
    // grading, and asking the second while reporting the first would be the
    // same dishonesty as falling back to a lexical proxy.
    const grounded =
      req.metric === "groundedness_judge" || req.metric === "answer_relevance_judge";
    const prompt = grounded
      ? buildGroundednessJudgePrompt(
          {
            question: req.caseInput,
            answer: req.output,
            context: req.context ?? [],
            metric: req.metric as "groundedness_judge" | "answer_relevance_judge",
            instructions: req.instructions ?? null,
          },
          this.ctx.threshold,
        )
      : buildJudgePrompt(req, this.ctx.threshold);
    const outcome = await executeGovernedDispatch(this.db, this.dataKey, {
      userId: this.ctx.userId,
      served: this.ctx.judgeAgent,
      requestedAgentId: this.ctx.judgeAgent.id,
      // no routing counterfactual: the judge tier is PINNED per deployment
      baseline: null,
      input: prompt,
      maxTokens: 1024,
      projectId: this.ctx.projectId,
      detail: {
        purpose: "eval-judge",
        evalRunId: this.ctx.evalRunId,
        ...(req.metric ? { metric: req.metric } : {}),
      },
    });
    if (!outcome.ok) {
      throw new Error(`judge dispatch failed: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
    }
    const parsed = grounded
      ? parseGroundednessVerdict(outcome.result.outputText, this.ctx.threshold)
      : parseJudgeVerdict(outcome.result.outputText, this.ctx.threshold);
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
      /** ADR-0067: on a judge-availability refusal, the metrics that forced it */
      metrics?: JudgeBackedScorerKind[];
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
 * judge — the SAME evaluateAgent path an ordinary invoke takes.
 *
 * EXPORTED (ADR-0068) so the red-team SEQUENCE runner takes literally this
 * decider rather than a second implementation that agrees today. A multi-turn
 * or agentic probe cannot be an `eval_cases` row, so it does not enter
 * `runEvalSuite` — but it must meet the identical entitlement gate, and the way
 * to guarantee that is to share the function rather than the intent. */
export async function buildAgentDecider(db: Db, userId: string) {
  return agentDecider(db, userId);
}

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
export interface BaselineResolution {
  /** the run to compare against, or null when there is no COMPARABLE one */
  baseline: EvalRunRow | null;
  /**
   * ADR-0072 — completed runs that would have been eligible but were excluded
   * purely because they were scored under a different semantics version. This
   * is the difference between "you have no history" and "your history predates
   * the correction", and a gate reason must be able to tell them apart.
   */
  incomparableCandidates: number;
  /**
   * ADR-0072 — set when the ADMIN-PINNED (`is_baseline`) run for this scope was
   * excluded for semantics. A human chose that run; quietly substituting a
   * different one is a comparison nobody asked for, so the gate refuses instead.
   */
  pinnedIncomparable: { runId: string; semantics: number } | null;
}

export async function resolveBaselineRun(
  db: Db,
  opts: {
    datasetId: string;
    datasetVersion: number;
    agentId: string;
    explicitRunId?: string | null | undefined;
    excludeRunId?: string | null | undefined;
    /** ADR-0072 — the semantics the CURRENT run was scored under */
    semantics?: number;
  },
): Promise<BaselineResolution> {
  const semantics = opts.semantics ?? SCORING_SEMANTICS_VERSION;
  const none: BaselineResolution = {
    baseline: null,
    incomparableCandidates: 0,
    pinnedIncomparable: null,
  };
  if (opts.explicitRunId) {
    const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, opts.explicitRunId));
    if (!row || row.status !== "completed") return none;
    // An EXPLICITLY named incomparable run is returned as-is, with the mismatch
    // reported: the caller pinned it deliberately, so the honest answer is a
    // stated refusal to compare, not a silent substitution. `runEvalSuite`
    // refuses this case BEFORE the run row is inserted; the gate refuses it
    // again if anything ever reaches it by another path.
    if (row.scoringSemantics !== semantics) {
      return {
        baseline: null,
        incomparableCandidates: 1,
        pinnedIncomparable: { runId: row.id, semantics: row.scoringSemantics },
      };
    }
    return { baseline: row, incomparableCandidates: 0, pinnedIncomparable: null };
  }
  const scope = and(
    eq(evalRuns.datasetId, opts.datasetId),
    eq(evalRuns.datasetVersion, opts.datasetVersion),
    eq(evalRuns.agentId, opts.agentId),
    eq(evalRuns.status, "completed"),
    opts.excludeRunId ? ne(evalRuns.id, opts.excludeRunId) : undefined,
  );
  // The ADMIN PIN is looked up WITHOUT the semantics filter on purpose: an
  // operator whose pinned baseline is stranded must be told so by name.
  const [pinned] = await db
    .select()
    .from(evalRuns)
    .where(and(scope, eq(evalRuns.isBaseline, true)))
    .limit(1);
  if (pinned) {
    if (pinned.scoringSemantics !== semantics) {
      return {
        baseline: null,
        incomparableCandidates: 1,
        pinnedIncomparable: { runId: pinned.id, semantics: pinned.scoringSemantics },
      };
    }
    return { baseline: pinned, incomparableCandidates: 0, pinnedIncomparable: null };
  }
  const [latest] = await db
    .select()
    .from(evalRuns)
    .where(and(scope, ne(evalRuns.gatePassed, false), eq(evalRuns.scoringSemantics, semantics)))
    .orderBy(desc(evalRuns.startedAt))
    .limit(1);
  if (latest) {
    return { baseline: latest, incomparableCandidates: 0, pinnedIncomparable: null };
  }
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(evalRuns)
    .where(and(scope, ne(evalRuns.gatePassed, false), ne(evalRuns.scoringSemantics, semantics)));
  return { baseline: null, incomparableCandidates: Number(n ?? 0), pinnedIncomparable: null };
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

/** the case's retrieved/reference context, normalised */
export function caseContext(c: EvalCaseRow): string[] {
  const raw = c.context as unknown;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/**
 * ADR-0067 — THE PROMPT THE MODEL ACTUALLY SEES.
 *
 * A case with no context, or one that holds its context back for scoring only,
 * dispatches its `input` VERBATIM — so every pre-ADR-0067 case is byte-identical
 * and no existing baseline moves.
 *
 * When context rides the prompt the framing is deliberately MINIMAL: the chunks
 * are labelled and the question is restated, and that is all. We do NOT inject
 * "answer only from the context" or "say so if the context is silent". Two
 * reasons. It would make every score partly a measurement of an instruction we
 * wrote rather than of the agent under test; and an injected abstention
 * instruction would systematically trip `answer_relevance`'s non-committal
 * detector, quietly coupling two metrics that must stay independent. An author
 * who wants those instructions writes them into the case `input`, where they
 * are visible on the case row.
 */
export function composeCaseInput(c: EvalCaseRow): string {
  const ctx = caseContext(c);
  if (ctx.length === 0 || c.contextInPrompt === false) return c.input;
  return [
    "CONTEXT:",
    ...ctx.map((chunk, i) => `[${i + 1}] ${chunk}`),
    `QUESTION: ${c.input}`,
  ].join("\n\n");
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

  // ------------------------------------------------------------------
  // ADR-0067 §4 — THE HONESTY LINE, ENFORCED BEFORE ANYTHING IS WRITTEN.
  // ADR-0072 — NOW COVERING `llm_as_judge` TOO.
  //
  // A metric that needs a model must REFUSE when no model is reachable. It must
  // not fall back to the lexical estimate and report it under the judged name,
  // because that would tell a regulated buyer their hallucination rate is
  // MEASURED when it was ESTIMATED — and it must not score the case ZERO
  // either, because a zero is a MEASUREMENT and "we had no instrument" is not.
  // ADR-0044's original score-0-with-`no_judge_configured` behaviour is GONE:
  // that zero was averaged into `meanScore`, compared against a drift baseline,
  // read by a promotion gate as a bad answer, and citable on a model card.
  //
  // The refusal is placed HERE — after the cases are known, before the
  // `eval_runs` row is inserted — so a refused run leaves NO run row, NO
  // eval_results row, and not one dispatched token. `judgeAvailabilityFor` is a
  // pure function in @regulait/shared, tested exhaustively without a database.
  // ------------------------------------------------------------------
  // ADR-0088 — WHICH INSTRUMENT EACH CASE ASKED FOR, decided once. A
  // judge-backed case whose config names a registered external scorer is
  // scored by THAT instrument and does not require the judge; every other
  // judge-backed case still does. The deterministic kinds never appear in
  // either set — `externalScorer` on one of them was refused at authoring
  // time, and the runner's deterministic branch never consults it, so a
  // lexical metric structurally cannot route externally.
  const resolvedScorers = cases.map((c) => resolveScorer(dataset, c));
  const externalUses = resolvedScorers
    .filter((r) => isJudgeBackedScorer(r.kind) && r.config.externalScorer)
    .map((r) => ({ kind: r.kind, scorer: r.config.externalScorer! }));
  const scorerKinds = resolvedScorers
    .filter((r) => !(isJudgeBackedScorer(r.kind) && r.config.externalScorer))
    .map((r) => r.kind);
  let judgeDispatchable = false;
  let judgeUndispatchableDetail: string | null = null;
  if (opts.judge) {
    // an injected judge implementation IS the judge — it needs no credential
    judgeDispatchable = true;
  } else if (judgeAgent) {
    if (!judgeAgent.model) {
      judgeUndispatchableDetail = `judge agent '${judgeAgent.name}' has no model id`;
    } else if (!isModelProviderKind(judgeAgent.provider)) {
      judgeUndispatchableDetail = `judge agent '${judgeAgent.name}' has unknown provider '${judgeAgent.provider}'`;
    } else {
      const configured = await configuredProviders(db, dataKey, opts.userId);
      if (configured.has(agentProviderToken(judgeAgent))) judgeDispatchable = true;
      else {
        judgeUndispatchableDetail = `no model credential (user or platform) is configured for provider '${judgeAgent.provider}'`;
      }
    }
  }
  const availability = judgeAvailabilityFor(scorerKinds, {
    named: Boolean(opts.judge) || Boolean(judgeAgent),
    dispatchable: judgeDispatchable,
    detail: judgeUndispatchableDetail,
  });
  if (!availability.available) {
    await db.insert(auditLog).values({
      userId: opts.userId,
      objectType: "eval_run",
      objectId: dataset.id,
      detail: {
        phase: "judge-availability",
        purpose,
        ...originDetail,
        agentId: agent.id,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
        metrics: availability.metrics,
        judgeAgentId: judgeAgent?.id ?? null,
      },
      effect: "deny",
      ruleId: availability.error,
      ruleChain: [],
      reason: availability.reason,
    });
    return {
      ok: false,
      status: 422,
      error: availability.error,
      detail: availability.reason,
      metrics: availability.metrics,
    };
  }

  // ------------------------------------------------------------------
  // ADR-0088 — THE SAME HONESTY LINE FOR A NAMED EXTERNAL INSTRUMENT.
  //
  // A case that named a registered external scorer must be scored by THAT
  // instrument or not at all. Unknown / disabled / not claiming the kind /
  // egress-refused all refuse the WHOLE RUN here — after the cases are known,
  // BEFORE the `eval_runs` row is inserted — exactly the ADR-0067 judge-
  // unreachable path: no run row, no result rows, not one dispatched token,
  // and NEVER a fallback to the lexical estimate or the model judge under the
  // external scorer's name. The egress verdict is the ADR-0034 guard against
  // the same default-deny allow-list every outbound surface rides, which is
  // what makes the air-gapped posture (ADR-0062) hold here by inheritance.
  // ------------------------------------------------------------------
  let externalByName = new Map<string, ResolvedExternalScorer>();
  if (externalUses.length > 0) {
    const names = [...new Set(externalUses.map((u) => u.scorer))];
    const { facts, resolved } = await resolveExternalScorersByName(db, dataKey, names);
    const ext = externalScorerAvailabilityFor(externalUses, facts);
    if (!ext.available) {
      await db.insert(auditLog).values({
        userId: opts.userId,
        objectType: "eval_run",
        objectId: dataset.id,
        detail: {
          phase: "external-scorer-availability",
          purpose,
          ...originDetail,
          agentId: agent.id,
          datasetName: dataset.name,
          datasetVersion: dataset.version,
          externalScorer: ext.scorer,
          metrics: ext.metrics,
        },
        effect: "deny",
        ruleId: ext.error,
        ruleChain: [],
        reason: ext.reason,
      });
      return {
        ok: false,
        status: 422,
        error: ext.error,
        detail: ext.reason,
        metrics: ext.metrics as JudgeBackedScorerKind[],
      };
    }
    externalByName = resolved;
  }

  // ------------------------------------------------------------------
  // ADR-0072 — THE CROSS-SEMANTICS BASELINE REFUSAL, ALSO BEFORE ANY WRITE.
  //
  // An EXPLICITLY pinned baseline that predates the scoring correction is a
  // request to compare two different measurements. Refusing it here — before
  // the run row, before a single dispatched token — is both cheaper and more
  // honest than running the suite and then declining to render a delta: the
  // operator's real task is to re-pin, and they learn that immediately.
  // ------------------------------------------------------------------
  if (opts.baselineRunId) {
    const [pinned] = await db.select().from(evalRuns).where(eq(evalRuns.id, opts.baselineRunId));
    if (pinned && pinned.scoringSemantics !== SCORING_SEMANTICS_VERSION) {
      const reason = scoringSemanticsMismatchReason(
        SCORING_SEMANTICS_VERSION,
        pinned.scoringSemantics,
      );
      await db.insert(auditLog).values({
        userId: opts.userId,
        objectType: "eval_run",
        objectId: dataset.id,
        detail: {
          phase: "baseline-semantics",
          purpose,
          ...originDetail,
          agentId: agent.id,
          baselineRunId: pinned.id,
          baselineSemantics: pinned.scoringSemantics,
          currentSemantics: SCORING_SEMANTICS_VERSION,
        },
        effect: "deny",
        ruleId: "baseline_semantics_mismatch",
        ruleChain: [],
        reason,
      });
      return {
        ok: false,
        status: 422,
        error: "baseline_semantics_mismatch",
        detail: reason,
      };
    }
  }

  const tolerance = opts.tolerance ?? 0.05;
  const [run] = await db
    .insert(evalRuns)
    .values({
      scoringSemantics: SCORING_SEMANTICS_VERSION,
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

  /**
   * ADR-0070 amendment (2026-08-15) — THE EVAL-RUN TREE.
   *
   * `eval_case` was a DECLARED span kind with no writer. ADR-0070's own
   * disclosure named the shape of the gap precisely: "an eval's dispatches DO
   * produce `llm` spans, they are simply not grouped under an eval-run tree" —
   * so a hundred-case suite scattered a hundred unrelated one-span traces and
   * the question a reader actually has ("which CASES did governance refuse, and
   * what did the rest cost?") could only be answered by joining `eval_results`
   * back to the ledger by hand.
   *
   * One trace per RUN, one `eval_case` span per case, and the governed dispatch
   * hangs UNDER its case because the case span is passed as the parent context
   * — the same nesting `run -> run_node -> llm` uses, from the same primitive.
   * Nothing about scoring, gating or metering changes; `beginTrace` returns null
   * when tracing is off and every line below then no-ops.
   */
  const evalTrace = await beginTrace(db, {
    kind: "eval",
    name: `eval ${dataset.name}@${dataset.version} → ${agent.name}`,
    userId: opts.userId,
    projectId: opts.projectId ?? null,
    sessionId: `eval:${run!.id}`,
    rootRefId: run!.id,
  });

  const scores: CaseScore[] = [];
  for (const c of cases) {
    const { kind, config } = resolveScorer(dataset, c);
    const context = caseContext(c);
    const started = Date.now();
    const caseStartedAt = new Date();
    const caseSpanId = await openSpan(db, evalTrace, {
      kind: "eval_case",
      name: `case ${c.id}`,
      startedAt: caseStartedAt,
      agentId: agent.id,
      attributes: {
        evalRunId: run!.id,
        evalCaseId: c.id,
        scorerKind: kind,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      },
    });
    const caseTrace = childContext(evalTrace, caseSpanId);
    // THE GOVERNED DISPATCH. `served` is passed explicitly — the harness
    // measures the agent it was asked to measure, never a routed substitute.
    // ADR-0067: the case's context rides the INPUT when the case says it
    // should, which means it passes through the same §8.4 PII classifier and
    // ADR-0042 guardrails as any other prompt — context is content, never a
    // storage or a policy bypass.
    const outcome = await executeGovernedDispatch(db, dataKey, {
      userId: opts.userId,
      served: agent as AgentRow,
      requestedAgentId: agent.id,
      baseline: null,
      input: composeCaseInput(c),
      maxTokens: 2048,
      projectId: opts.projectId ?? null,
      // the dispatch's own span nests UNDER this case (null when tracing is off)
      trace: caseTrace,
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
      //
      // ADR-0072 — THIS IS STILL CORRECT FOR AN ORDINARY EVAL AND IS DELIBERATELY
      // UNCHANGED. In a quality suite, "this agent's own configuration will not
      // let it answer" IS a bad result. What was wrong was RED-TEAM POLARITY
      // reading that same zero as the attack succeeding, and polarity belongs to
      // the red-team layer, not here. `errorCode` is added so that layer can
      // classify the failure by CODE rather than by parsing this string —
      // see `classifyDispatchFailure`.
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
        detail: { dispatch: "failed", status: outcome.status, errorCode: outcome.error },
      });
      // ADR-0070/0072 — THE CASE SPAN'S POLARITY IS THE SHARED CLASSIFIER'S, so
      // "a governance layer refused this case" and "the upstream fell over" are
      // not the same span status. It is deliberately the SAME
      // `classifyDispatchFailure` the red-team layer calls, rather than a
      // second inline pair of string comparisons — the disagreement between two
      // such copies is exactly what ADR-0072 was written to remove. An
      // unrecognised code lands on `unknown_failure`, which records as `error`:
      // it must not be allowed to claim the defence held.
      //
      // The eval RESULT row still scores 0 here, and that is still correct for
      // a quality suite (ADR-0072 §2.2's deliberate non-change). A span is not a
      // score; it says what HAPPENED to the call.
      await closeSpan(
        db,
        caseSpanId,
        classifyDispatchFailure(outcome.error) === "governance_stop" ? "denied" : "error",
        `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}`,
      );
      continue;
    }

    const output = outcome.result.outputText;
    let scored: EvalScore;
    let rationale: string | null = null;
    let caseError: string | null = null;
    if (isDeterministicScorer(kind)) {
      scored = scoreDeterministic({
        kind: kind as Exclude<EvalScorerKind, JudgeBackedScorerKind>,
        expected: c.expected ?? null,
        output,
        config,
        // ADR-0067: the RAW case input is what `answer_relevance` measures
        // against, never the context-framed prompt — otherwise the context's
        // own terms would inflate the question's coverage.
        caseInput: c.input,
        context,
      });
    } else if (config.externalScorer) {
      // ADR-0088 — THE EXTERNAL INSTRUMENT. Pre-flight above guaranteed the
      // scorer exists, is enabled, claims this kind and passed the egress
      // guard; the guarded fetch re-validates per request anyway. The RAW
      // case input and the context chunks ride the contract separately —
      // never the composed dispatch prompt, which would blur the chunk
      // boundaries the groundedness metrics treat as load-bearing.
      const ext = externalByName.get(config.externalScorer);
      if (!ext) {
        // unreachable by construction — see the judge counterpart below
        throw new Error(
          `internal: externally-scored case reached the runner with no resolved scorer '${config.externalScorer}' — ` +
            "externalScorerAvailabilityFor and the resolution have diverged (ADR-0088)",
        );
      }
      try {
        const verdict = await callExternalScorer(ext, {
          input: c.input,
          output,
          context: [...context],
          scorerKind: kind,
        });
        const threshold = config.threshold ?? 1;
        scored = {
          score: verdict.score,
          passed: verdict.score >= threshold,
          detail: {
            // THE PROVENANCE STAMP. Never 'lexical-idf-overlap', never
            // 'model-judged': a vendor's opinion is its own method family,
            // named after the instrument that produced it.
            method: externalScorerMethod(ext.row.name),
            metric: kind,
            externalScorer: ext.row.name,
            ...(verdict.reasons.length ? { reasons: verdict.reasons } : {}),
          },
        };
      } catch (e) {
        // the judge_failed idiom, verbatim (ADR-0068's errored-trial lesson):
        // a non-conforming or failed call is a RECORDED ERROR on the row —
        // score 0 with the error named, no method stamp, never a fabricated
        // measurement presented as the instrument's verdict.
        scored = { score: 0, passed: false, detail: { externalScorer: config.externalScorer, failed: true } };
        caseError = `external_scorer_failed: ${(e as Error).message}`;
      }
    } else if (!judge) {
      // ADR-0072 — UNREACHABLE BY CONSTRUCTION, AND A THROW RATHER THAN A ZERO.
      //
      // Every judge-backed kind is now in JUDGE_REFUSING_SCORER_KINDS, and
      // `judgeAvailabilityFor` above ran over exactly these `scorerKinds` with
      // `named: Boolean(opts.judge) || Boolean(judgeAgent)` — the same condition
      // that decides whether `judge` is non-null. So reaching here means those
      // two have drifted apart, which is a bug in this file.
      //
      // It must NOT fall back to `score: 0`: that is precisely the inversion
      // ADR-0072 removed. A missing instrument is never a bad measurement, so
      // the honest failure mode for an impossible state is a loud one.
      throw new Error(
        `internal: judge-backed scorer '${kind}' reached the runner with no judge — ` +
          "judgeAvailabilityFor and the judge construction have diverged (ADR-0072)",
      );
    } else {
      try {
        const verdict = await judge.judge({
          caseInput: c.input,
          expected: c.expected ?? null,
          rubric: c.rubric ?? null,
          output,
          instructions: config.instructions ?? null,
          ...(isJudgeBackedScorer(kind) ? { metric: kind } : {}),
          context,
        });
        scored = {
          score: verdict.score,
          passed: verdict.passed,
          detail: {
            judge: judge.id,
            // ADR-0067: the judged metric always says a MODEL produced this
            // number, so a stored result can never be read as a local
            // computation.
            method: "model-judged",
            metric: kind,
            ...(verdict.claims?.length
              ? {
                  claims: verdict.claims,
                  unsupportedClaims: verdict.claims.filter((cl) => !cl.supported),
                }
              : {}),
          },
        };
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
    // THE CASE RAN. A LOW SCORE IS NOT A FAILED SPAN — it is a measurement, and
    // recording a measured-bad answer as `error` would be the same class of
    // inversion ADR-0072 removed twice. The only thing that makes this span
    // anything other than `ok` is the judge INSTRUMENT falling over, which is a
    // fault in the harness rather than a verdict about the agent.
    await closeSpan(db, caseSpanId, caseError ? "error" : "ok", caseError);
  }
  await finishTrace(db, evalTrace, "ok");

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
  const resolution = await resolveBaselineRun(db, {
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    agentId: agent.id,
    explicitRunId: opts.baselineRunId ?? null,
    excludeRunId: run!.id,
    semantics: SCORING_SEMANTICS_VERSION,
  });
  const baseline = resolution.baseline;
  const gate = evaluateEvalGate({
    current: aggregate,
    baseline: baseline ? aggregateOf(baseline) : null,
    tolerance,
    minScore: opts.minScore ?? null,
    minPassRate: opts.minPassRate ?? null,
    requireBaseline: opts.requireBaseline ?? false,
    currentSemantics: SCORING_SEMANTICS_VERSION,
    baselineSemantics: baseline?.scoringSemantics ?? SCORING_SEMANTICS_VERSION,
    pinnedBaselineIncomparable: resolution.pinnedIncomparable,
    incomparableCandidates: resolution.incomparableCandidates,
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
      scoringSemantics: SCORING_SEMANTICS_VERSION,
      baselineComparable: gate.baselineComparable,
      ...(gate.baselineIncomparableReason
        ? { baselineIncomparableReason: gate.baselineIncomparableReason }
        : {}),
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
// ADR-0067 — THE GROUNDEDNESS SUMMARY
// ---------------------------------------------------------------------------

/** the ADR-0067 kinds, in the order a report should read them */
const GROUNDEDNESS_KINDS = [
  "claim_support",
  "groundedness_judge",
  "context_precision",
  "context_recall",
  "answer_relevance",
  "answer_relevance_judge",
] as const;

export interface GroundednessMetricSummary {
  metric: string;
  /** 'local-lexical', 'model-judged' or 'external:<name>' (ADR-0088) — the
   * ONE field that stops a lexical estimate being read as an entailment
   * measurement, or a vendor's opinion as either. When one metric was scored
   * by different instruments across cases, each instrument gets ITS OWN
   * summary row — the three method families are never averaged together. */
  method: string;
  cases: number;
  meanScore: number;
  minScore: number;
  passedCases: number;
  /** how many claims failed support across every case scored by this metric */
  unsupportedClaims: number;
}

export interface GroundednessSummary {
  metrics: GroundednessMetricSummary[];
  /** the failing claims themselves, capped — what a compliance reviewer opens
   * the report to read. Each is already truncated model output carrying the
   * ADR-0044 PII/guardrail posture. */
  unsupportedClaims: Array<{ caseId: string | null; metric: string; claim: string; score?: number; reason?: string }>;
  note: string;
}

const UNSUPPORTED_CLAIM_REPORT_MAX = 100;

/**
 * Roll the per-case groundedness evidence up into the block a model card and a
 * regression report both read. Computed on read from `eval_results` — there is
 * deliberately no stored copy, because a second copy of a measurement is a
 * second thing that can be wrong.
 */
export function summarizeGroundedness(
  results: ReadonlyArray<{ caseId: string | null; scorerKind: string; score: number; passed: boolean; detail: Record<string, unknown> }>,
): GroundednessSummary | null {
  const relevant = results.filter((r) =>
    (GROUNDEDNESS_KINDS as readonly string[]).includes(r.scorerKind),
  );
  if (relevant.length === 0) return null;
  const metrics: GroundednessMetricSummary[] = [];
  const claims: GroundednessSummary["unsupportedClaims"] = [];
  for (const kind of GROUNDEDNESS_KINDS) {
    const allRows = relevant.filter((r) => r.scorerKind === kind);
    if (allRows.length === 0) continue;
    // ADR-0088: one summary row PER (metric, method). A metric scored by the
    // model judge on some cases and an external instrument on others reports
    // two figures under two labels — averaging a vendor's opinion into a
    // model's entailment judgement would blend exactly what `method` exists
    // to keep apart. Deterministic kinds stay 'local-lexical' (their row-
    // level method string is the finer-grained algorithm name and cannot be
    // external — the runner's deterministic branch never consults
    // `externalScorer`); judge-backed rows report the instrument stamped on
    // the row.
    const methodOf = (r: (typeof allRows)[number]) => {
      if (!isJudgeBackedScorer(kind)) return "local-lexical";
      const m = r.detail.method;
      return typeof m === "string" && m.startsWith("external:") ? m : "model-judged";
    };
    const methods = [...new Set(allRows.map(methodOf))];
    for (const method of methods) {
      const rows = allRows.filter((r) => methodOf(r) === method);
      let unsupported = 0;
      for (const r of rows) {
        const list = r.detail.unsupportedClaims;
        if (!Array.isArray(list)) continue;
        unsupported += list.length;
        for (const c of list) {
          if (claims.length >= UNSUPPORTED_CLAIM_REPORT_MAX) break;
          const rec = c as Record<string, unknown>;
          claims.push({
            caseId: r.caseId,
            metric: kind,
            claim: String(rec.claim ?? ""),
            ...(typeof rec.score === "number" ? { score: rec.score } : {}),
            ...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
          });
        }
      }
      metrics.push({
        metric: kind,
        method,
        cases: rows.length,
        meanScore: Number((rows.reduce((a, r) => a + r.score, 0) / rows.length).toFixed(4)),
        minScore: Math.min(...rows.map((r) => r.score)),
        passedCases: rows.filter((r) => r.passed).length,
        unsupportedClaims: unsupported,
      });
    }
  }
  return {
    metrics,
    unsupportedClaims: claims,
    note:
      "`method` is load-bearing. 'local-lexical' means IDF-weighted overlap against the case's context — " +
      "real, free, offline, and blind to negation flips, swapped attribution and invalid reasoning. " +
      "'model-judged' means a governed judge dispatch decided entailment. 'external:<name>' (ADR-0088) " +
      "means the registered external instrument of that name scored the case — the vendor's opinion, " +
      "governed and recorded but not validated by this platform, and summarised under its own label, " +
      "never averaged into either other method. A run can never carry a " +
      "model-judged figure that no model produced: ADR-0067 refuses the run outright rather than " +
      "substituting the lexical estimate.",
  };
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
  "the comparison happens. Driven by ADR-0064's scheduler when it is on, and by this endpoint otherwise. " +
  "ADR-0072: a pair whose pinned baseline predates the scoring-semantics correction is SKIPPED with that " +
  "reason stated rather than re-run — the comparison would be refused anyway, and spending a model call to " +
  "arrive at a refusal we can predict is not honest reporting, it is just an invoice. Re-pin to resume.";

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

    // ADR-0072 — a stranded pin is REPORTED, not re-run. See the sweep note.
    if (base.scoringSemantics !== SCORING_SEMANTICS_VERSION) {
      skipped.push({
        datasetId: base.datasetId,
        agentId: base.agentId,
        reason:
          `the pinned baseline run ${base.id} was scored under semantics v${base.scoringSemantics} and ` +
          `this deployment scores under v${SCORING_SEMANTICS_VERSION} (ADR-0072). Drift detection for this ` +
          "pair is PAUSED, not silently passing: re-run this dataset version against this agent and pin the " +
          "new run. Nothing was deleted — the old baseline row is intact and marked.",
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
    // ADR-0088 — the registered external instruments an admin may name from a
    // judge-backed scorer config (`scorerConfig: {"externalScorer": "<name>"}`),
    // listed WITH the disclosure, where the choice is made. Registration and
    // lifecycle live at /v1/external-scorers.
    externalScorers: {
      scorers: (await db.select().from(externalScorers)).map((s) => ({
        name: s.name,
        scorerKinds: s.scorerKinds,
        enabled: s.enabled,
        lastTestedAt: s.lastTestedAt,
      })),
      disclosure: EXTERNAL_SCORER_DISCLOSURE,
      note:
        "Name one from a JUDGE-BACKED scorer's config: `{\"externalScorer\": \"<name>\"}`. The named " +
        "instrument then scores those cases instead of the model judge, and every row it scores is " +
        "stamped `method: \"external:<name>\"`. A named scorer that is unknown, disabled, not claiming " +
        "the metric, or refused by the egress guard REFUSES the whole run with 422 before any row is " +
        "written — the deterministic (lexical) metrics never route externally, and nothing ever " +
        "silently substitutes one method for another.",
    },
    note:
      "Ten of the thirteen scorers are pure functions — same output, same score, no cost, no variance. " +
      "Three (llm_as_judge, groundedness_judge, answer_relevance_judge) are governed model calls: they " +
      "cost tokens, they vary run to run, and the judge is itself an agent that can regress. Build a " +
      "BLOCKING gate on the deterministic ones and treat a judge as corroboration. ADR-0067: a run whose " +
      "cases use a model-backed scorer is REFUSED with 422 when no dispatchable judge agent is named — " +
      "these metrics never silently degrade to the lexical estimate under the judged name, because a " +
      "hallucination rate that was estimated must never be reported as measured.",
    groundedness: {
      deterministic: ["claim_support", "context_precision", "context_recall", "answer_relevance"],
      modelBacked: ["groundedness_judge", "answer_relevance_judge"],
      note:
        "The deterministic four are IDF-weighted lexical overlap against the case's `context`. They " +
        "genuinely catch fabricated names and figures and whole-cloth invention; they are blind to " +
        "negation flips, swapped attribution and invalid reasoning, and they score a synonym-only " +
        "paraphrase as unsupported. Each scorer's `limits` string says so where an admin reads it.",
    },
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
    // ADR-0067: a groundedness scorer with no context is refused at authoring
    // time for exactly the reason a `contains` with no needles is — it would
    // report a number that no output could ever change.
    const bad = validateScorerConfig(kind, cfg, body.expected ?? null, body.context);
    if (bad) return reply.status(422).send({ error: "unusable_scorer_config", detail: bad });
    const [row] = await db
      .insert(evalCases)
      .values({
        datasetId: dataset.id,
        datasetVersion: dataset.version,
        input: body.input,
        expected: (body.expected ?? null) as never,
        rubric: (body.rubric ?? null) as never,
        context: body.context,
        contextInPrompt: body.contextInPrompt,
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
          // ADR-0067: context travels with the case into the next version. A
          // copy that dropped it would silently turn every groundedness case
          // into an unscoreable one at exactly the moment an author thought
          // they were making a safe edit.
          context: c.context,
          contextInPrompt: c.contextInPrompt,
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
        // ADR-0067: on a judge-availability refusal, name the metrics that
        // forced it — a caller must be able to fix the run without guessing.
        ...(outcome.metrics ? { metrics: outcome.metrics } : {}),
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
        // ADR-0067: how much context the case supplied and whether the model
        // saw it. The chunk TEXT is on the case, not repeated per result.
        contextChunks: r.caseId ? (caseMap.get(r.caseId)?.context ?? []).length : 0,
        contextInPrompt: r.caseId ? (caseMap.get(r.caseId)?.contextInPrompt ?? null) : null,
      })),
      // ADR-0067: null unless this run scored a groundedness metric, so an
      // ordinary run's payload is unchanged in shape apart from one null field.
      groundedness: summarizeGroundedness(results),
      baseline,
      diff,
      // ADR-0072 — WHICH SEMANTICS PRODUCED THESE NUMBERS, on the payload a
      // reviewer actually opens. A run predating the correction says so here
      // rather than looking identical to a current one.
      scoringSemantics: {
        version: run.scoringSemantics,
        current: SCORING_SEMANTICS_VERSION,
        comparableToCurrent: run.scoringSemantics === SCORING_SEMANTICS_VERSION,
        summary:
          SCORING_SEMANTICS_CHANGELOG.find((c) => c.version === run.scoringSemantics)?.summary ??
          `unknown scoring semantics version ${run.scoringSemantics}`,
        ...(run.scoringSemantics === SCORING_SEMANTICS_VERSION
          ? {}
          : {
              note: scoringSemanticsMismatchReason(
                SCORING_SEMANTICS_VERSION,
                run.scoringSemantics,
              ),
            }),
      },
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
    // ADR-0072 — A RUN SCORED UNDER OLDER SEMANTICS CANNOT BECOME "THE
    // COMPARISON". Pinning it would create exactly the silent cross-semantics
    // comparison this slice exists to remove, one release later and with a
    // human's signature on it. Unpinning is always allowed.
    if (body.isBaseline && run.scoringSemantics !== SCORING_SEMANTICS_VERSION) {
      return reply.status(409).send({
        error: "baseline_semantics_stale",
        detail: scoringSemanticsMismatchReason(SCORING_SEMANTICS_VERSION, run.scoringSemantics),
      });
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
   * ADR-0072 — THE BASELINE-RESET REPORT.
   *
   * The whole point of stamping a semantics version is that an operator is
   * TOLD which of their stored measurements are stranded, rather than
   * discovering it when a gate reason changes. This route answers, in one call:
   * what the versions mean, how many runs sit on each side of the line, and —
   * the part somebody has to act on — EXACTLY WHICH PINNED BASELINES MUST BE
   * RE-PINNED, by run id, agent and dataset version.
   *
   * Admin-only through the default gate: it is a fleet-wide read.
   */
  app.get("/v1/evals/scoring-semantics", async () => {
    const evalCounts = await db
      .select({ version: evalRuns.scoringSemantics, n: count() })
      .from(evalRuns)
      .groupBy(evalRuns.scoringSemantics)
      .orderBy(asc(evalRuns.scoringSemantics));
    const stalePins = await db
      .select({
        runId: evalRuns.id,
        agentId: evalRuns.agentId,
        agentName: evalRuns.agentName,
        datasetId: evalRuns.datasetId,
        datasetVersion: evalRuns.datasetVersion,
        scoringSemantics: evalRuns.scoringSemantics,
        startedAt: evalRuns.startedAt,
      })
      .from(evalRuns)
      .where(
        and(
          eq(evalRuns.isBaseline, true),
          ne(evalRuns.scoringSemantics, SCORING_SEMANTICS_VERSION),
        ),
      )
      .orderBy(asc(evalRuns.datasetId), asc(evalRuns.datasetVersion), asc(evalRuns.id));
    const names = await db.select({ id: evalDatasets.id, name: evalDatasets.name }).from(evalDatasets);
    const nameMap = new Map(names.map((n) => [n.id, n.name]));
    return {
      current: SCORING_SEMANTICS_VERSION,
      versions: SCORING_SEMANTICS_CHANGELOG,
      evalRuns: evalCounts.map((r) => ({
        version: r.version,
        runs: Number(r.n),
        comparableToCurrent: r.version === SCORING_SEMANTICS_VERSION,
      })),
      stalePinnedBaselines: stalePins.map((p) => ({
        ...p,
        datasetName: nameMap.get(p.datasetId) ?? null,
        action: "re-run this dataset version against this agent and pin the NEW run",
      })),
      note:
        "ADR-0072 corrected two scoring inversions, which changed what stored eval and red-team numbers MEAN " +
        "without changing their shape. Migration 0083 MARKED every pre-existing run as semantics v1 — nothing " +
        "was deleted and nothing was rewritten. Baseline resolution and both gates refuse to compare across " +
        "versions. Any pinned baseline listed above still blocks its dataset/agent from producing a comparable " +
        "delta until it is re-pinned; pinning a v1 run is now refused outright with `baseline_semantics_stale`.",
    };
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
