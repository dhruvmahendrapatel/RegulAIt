/**
 * ADR-0057 — the GATEWAY half of CONTINUOUS RED-TEAMING.
 *
 * Division of labour:
 *
 *   `packages/shared/src/redteam.ts`  the attack-class registry, the built-in
 *                                     probe corpus, the oracle validator, the
 *                                     per-class aggregate math, and the
 *                                     per-class regression gate. Pure.
 *   THIS FILE                         versions attack libraries, MATERIALIZES a
 *                                     published library into an ADR-0044 eval
 *                                     dataset, drives runs through
 *                                     `runEvalSuite`, records findings, and
 *                                     owns the admin surface.
 *   `evals.ts` / `workflows.ts`       unchanged. The runner, the governed
 *                                     dispatch, the metering, the audit row and
 *                                     the promotion block are ALL theirs.
 *
 * THE ONE STRUCTURAL CLAIM
 *
 *   There is no red-team runner. A probe is an `eval_cases` row; a red-team run
 *   is an `eval_runs` row plus a security reading of it. That is what makes
 *   "probes run through the same governed surface as real traffic"
 *   (ADR-0057 §2) a property of the schema rather than a promise: there is no
 *   other code path a probe could take. The entitlement check, the guardrail
 *   pass, the `usage_events` cost row and the `audit_log` row are the ones
 *   ADR-0044 already writes; the only addition is an ORIGIN TAG (`purpose:
 *   'redteam'`) on the dispatch detail, so adversarial traffic is separable
 *   from real usage in the pillar-5 dashboard rather than polluting it.
 *
 *   Promotion blocking needs NO code here at all. A published library is an
 *   ordinary eval dataset, so an `automated_check` stage binds to it with the
 *   existing `evals:` binding and a regression parks the instance at
 *   `blocked_on_check` through the existing route. Nothing in this file can
 *   block anything, which is exactly the intent.
 *
 * WHAT IS GENUINELY ENFORCED HERE, AND WHAT IS NOT (ADR-0057 amendment)
 *
 *   ENFORCED AND TESTED: the corpus produces true positives AND true negatives
 *   against the deterministic rig; a defeat becomes a `redteam_findings` row and
 *   reaches a model card through the EXISTING `model_card_evidence` table; a
 *   probe run by an unentitled user is denied at the same `evaluateAgent` gate
 *   an invoke uses; probe dispatches are metered into `usage_events`; and a
 *   red-team regression parks a workflow instance at `blocked_on_check`.
 *
 *   NOT VERIFIED: no model provider is connected. Every scored probe here was
 *   answered by the in-memory deterministic provider, so what is proven is the
 *   MECHANISM — corpus, oracle, aggregation, gate, findings, evidence, block —
 *   and not any real model's actual resistance to any real attack. Model-graded
 *   probes ride ADR-0044's `EvalJudge` interface unchanged and are
 *   mechanism-proven, judgment-unverified.
 *
 *   SCHEDULING (was NOT BUILT, now is — ADR-0064): this codebase has an
 *   in-process scheduler, OFF by default. When it is switched on
 *   (REGULAIT_SCHEDULER=on) the `redteam-sweep` job drives
 *   `runScheduledRedTeamSweep` below, which re-probes the pairs a human has
 *   already chosen to probe, under that human's own entitlements. When it is
 *   off, "continuous" still means an operator or cron — now against
 *   `POST /v1/redteam/scheduled-sweep`, which calls the identical function, or
 *   `POST /v1/redteam/runs` for a single pair. `GET /v1/redteam/attack-classes`
 *   reports which of those two worlds this deployment is in rather than
 *   assuming.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
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
  inArray,
  modelCardEvidence,
  modelCards,
  redteamFindings,
  redteamLibraries,
  redteamProbes,
  redteamRuns,
  sql,
  users,
  type Db,
  type RedTeamLibraryRow,
  type RedTeamProbeRow,
  type RedTeamRunRow,
} from "@regulait/db";
import {
  RED_TEAM_ATTACK_CLASSES,
  RED_TEAM_COVERAGE_DISCLOSURE,
  RED_TEAM_ORIGIN_TAG,
  aggregateRedTeamByClass,
  attachRedTeamEvidenceSchema,
  builtinRedTeamLibrary,
  createRedTeamLibrarySchema,
  createRedTeamProbeSchema,
  evaluateRedTeamGate,
  redTeamAttackClassRegistry,
  redTeamOverallAggregate,
  startRedTeamRunSchema,
  validateRedTeamProbe,
  type EvalScorerConfig,
  type EvalScorerKind,
  type RedTeamAttackClass,
  type RedTeamClassAggregate,
  type RedTeamGateDecision,
  type RedTeamProbeOutcome,
  type RedTeamSeverity,
} from "@regulait/shared";
import { runEvalSuite, type EvalRunOutcome } from "./evals.js";
import { assertProjectAttribution } from "./projects.js";
import { resolveSchedulerConfig } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the tag prefix that binds a materialized eval case back to its probe. Tags
 * (not a join table) because `eval_cases` must stay exactly the shape ADR-0044
 * defined — a red-team FK on it would make the eval harness depend on the
 * subsystem that reuses it. */
const PROBE_TAG = "redteam:probe:";
const CLASS_TAG = "redteam:class:";

export function probeKeyFromTags(tags: readonly string[] | null | undefined): string | null {
  const hit = (tags ?? []).find((t) => t.startsWith(PROBE_TAG));
  return hit ? hit.slice(PROBE_TAG.length) : null;
}

// ---------------------------------------------------------------------------
// Library lifecycle
// ---------------------------------------------------------------------------

export interface PublishOutcome {
  ok: boolean;
  status: number;
  error?: string;
  detail?: string;
  library?: RedTeamLibraryRow;
  datasetId?: string;
  cases?: number;
}

/**
 * PUBLISH = MATERIALIZE. A draft library becomes an immutable eval dataset
 * version whose cases are its probes, and from that moment the library is
 * frozen: editing it mints the next version, exactly as editing a scored eval
 * dataset does. Publishing an empty library is refused — a library with no
 * probes would produce a green run that certifies nothing, which is the
 * failure mode this whole subsystem exists to prevent.
 */
export async function publishRedTeamLibrary(
  db: Db,
  libraryId: string,
  userId: string | null,
): Promise<PublishOutcome> {
  const [library] = await db.select().from(redteamLibraries).where(eq(redteamLibraries.id, libraryId));
  if (!library) return { ok: false, status: 404, error: "unknown_library" };
  if (library.status === "published") {
    return {
      ok: false,
      status: 409,
      error: "library_already_published",
      detail: `'${library.name}' v${library.version} is frozen — POST /v1/redteam/libraries/${library.id}/versions to mint the next version and edit that`,
    };
  }
  const probes = await db
    .select()
    .from(redteamProbes)
    .where(eq(redteamProbes.libraryId, library.id))
    .orderBy(asc(redteamProbes.probeKey));
  if (probes.length === 0) {
    return {
      ok: false,
      status: 422,
      error: "empty_library",
      detail: "a library with no probes would produce a green run that certifies nothing",
    };
  }

  const datasetName = `redteam:${library.name}:v${library.version}`;
  const [existing] = await db
    .select({ n: count() })
    .from(evalDatasets)
    .where(eq(evalDatasets.name, datasetName));
  if ((existing?.n ?? 0) > 0) {
    return { ok: false, status: 409, error: "dataset_name_taken", detail: datasetName };
  }

  const [dataset] = await db
    .insert(evalDatasets)
    .values({
      name: datasetName,
      version: 1,
      note:
        `ADR-0057 red-team corpus '${library.name}' v${library.version}, materialized. ` +
        `${probes.length} adversarial probe(s). ${RED_TEAM_COVERAGE_DISCLOSURE}`,
      // every probe overrides this; the dataset default exists only so the
      // dataset row is well-formed
      scorerKind: "contains",
      scorerConfig: {},
      createdByUserId: userId,
    })
    .returning();

  await db.insert(evalCases).values(
    probes.map((p) => ({
      datasetId: dataset!.id,
      datasetVersion: dataset!.version,
      input: p.input,
      expected: (p.expected ?? null) as never,
      rubric: null as never,
      tags: [
        "redteam",
        `${PROBE_TAG}${p.probeKey}`,
        `${CLASS_TAG}${p.attackClass}`,
        `redteam:severity:${p.severity}`,
      ],
      scorerKind: p.scorerKind as EvalScorerKind,
      scorerConfig: p.scorerConfig,
    })),
  );

  const [updated] = await db
    .update(redteamLibraries)
    .set({
      status: "published",
      evalDatasetId: dataset!.id,
      evalDatasetVersion: dataset!.version,
      publishedAt: new Date(),
    })
    .where(eq(redteamLibraries.id, library.id))
    .returning();

  await db.insert(auditLog).values({
    userId: userId ?? NIL_UUID,
    objectType: "eval_run",
    objectId: dataset!.id,
    detail: {
      phase: "redteam-library-published",
      libraryId: library.id,
      libraryName: library.name,
      libraryVersion: library.version,
      datasetName,
      probes: probes.length,
      classes: [...new Set(probes.map((p) => p.attackClass))],
    },
    effect: "allow",
    ruleId: "redteam-library-published",
    ruleChain: [],
    reason:
      `red-team attack library '${library.name}' v${library.version} published as eval dataset '${datasetName}' ` +
      `(${probes.length} probes). Every result from here on is stamped with this library version.`,
  });

  return { ok: true, status: 201, library: updated!, datasetId: dataset!.id, cases: probes.length };
}

/** Seed the built-in corpus. Idempotent by (name, version): a second call
 * returns the existing library rather than duplicating it. */
export async function seedBuiltinRedTeamLibrary(
  db: Db,
  userId: string | null,
): Promise<{ library: RedTeamLibraryRow; created: boolean }> {
  const seed = builtinRedTeamLibrary();
  const [existing] = await db
    .select()
    .from(redteamLibraries)
    .where(and(eq(redteamLibraries.name, seed.name), eq(redteamLibraries.version, seed.version)));
  if (existing) return { library: existing, created: false };

  const [library] = await db
    .insert(redteamLibraries)
    .values({
      name: seed.name,
      version: seed.version,
      note: seed.note,
      status: "draft",
      createdByUserId: userId,
    })
    .returning();
  await db.insert(redteamProbes).values(
    seed.probes.map((p) => ({
      libraryId: library!.id,
      probeKey: p.probeKey,
      attackClass: p.attackClass,
      severity: p.severity,
      input: p.input,
      scorerKind: p.scorerKind,
      scorerConfig: p.scorerConfig as Record<string, unknown>,
      expected: (p.expected ?? null) as never,
      note: p.note,
    })),
  );
  return { library: library!, created: true };
}

// ---------------------------------------------------------------------------
// The runner — a thin security reading over `runEvalSuite`
// ---------------------------------------------------------------------------

export interface RedTeamRunOptions {
  libraryId: string;
  agentId: string;
  userId: string;
  trigger: "manual" | "scheduled" | "workflow";
  mode?: string;
  judgeAgentId?: string | null | undefined;
  projectId?: string | null | undefined;
  gatingClasses?: readonly RedTeamAttackClass[] | undefined;
  tolerance?: number;
  minScore?: number | null | undefined;
  minResistRate?: number | null | undefined;
  failOnSeverity?: RedTeamSeverity | null | undefined;
  requireBaseline?: boolean;
  note?: string | null | undefined;
  /** ADR-0044's test seam, passed straight through for llm_as_judge probes */
  judge?: Parameters<typeof runEvalSuite>[2]["judge"];
}

export type RedTeamRunOutcome =
  | {
      ok: true;
      run: RedTeamRunRow;
      classes: RedTeamClassAggregate[];
      gate: RedTeamGateDecision;
      findings: number;
      baseline: RedTeamRunRow | null;
    }
  | { ok: false; status: number; error: string; detail?: string; decision?: unknown };

/**
 * ADR-0057 §7: the baseline is the last *promoted*-quality run for this
 * (library version, agent). Precedence mirrors `resolveBaselineRun` exactly:
 * the most recent completed run that did not itself fail its gate, never the
 * run being scored.
 */
export async function resolveRedTeamBaseline(
  db: Db,
  opts: { libraryId: string; agentId: string; excludeRunId?: string | null },
): Promise<RedTeamRunRow | null> {
  const rows = await db
    .select()
    .from(redteamRuns)
    .where(and(eq(redteamRuns.libraryId, opts.libraryId), eq(redteamRuns.agentId, opts.agentId)))
    .orderBy(desc(redteamRuns.startedAt));
  return (
    rows.find((r) => r.id !== opts.excludeRunId && r.gatePassed !== false && r.finishedAt !== null) ??
    null
  );
}

function classAggregatesOf(run: RedTeamRunRow): RedTeamClassAggregate[] {
  return (run.classSummary ?? []) as RedTeamClassAggregate[];
}

/**
 * RUN A RED-TEAM SUITE. Two steps and nothing else:
 *
 *   1. `runEvalSuite` on the library's materialized dataset, tagged with the
 *      red-team origin. Everything governance-shaped happens in there.
 *   2. Read the per-case results back, map each to its probe through the case
 *      tags, aggregate per attack class, resolve the baseline, decide the gate,
 *      and write the findings.
 *
 * A failure in step 1 (an unentitled caller, a missing agent) is returned
 * VERBATIM: a red-team run must not have a softer refusal path than an eval run,
 * because that would make it the side channel the whole design forbids.
 */
export async function runRedTeamSuite(
  db: Db,
  dataKey: string | undefined,
  opts: RedTeamRunOptions,
): Promise<RedTeamRunOutcome> {
  const [library] = await db
    .select()
    .from(redteamLibraries)
    .where(eq(redteamLibraries.id, opts.libraryId));
  if (!library) return { ok: false, status: 404, error: "unknown_library" };
  if (library.status !== "published" || !library.evalDatasetId) {
    return {
      ok: false,
      status: 409,
      error: "library_not_published",
      detail: "publish the library first — an unpublished library has no materialized dataset to run",
    };
  }

  const probes = await db.select().from(redteamProbes).where(eq(redteamProbes.libraryId, library.id));
  const probeByKey = new Map<string, RedTeamProbeRow>(probes.map((p) => [p.probeKey, p]));

  const evalOutcome: EvalRunOutcome = await runEvalSuite(db, dataKey, {
    datasetId: library.evalDatasetId,
    agentId: opts.agentId,
    userId: opts.userId,
    // the eval ledger's own vocabulary; the red-team trigger is stamped on the
    // redteam_runs row and on the origin detail below
    trigger: opts.trigger === "scheduled" ? "scheduled" : opts.trigger === "workflow" ? "workflow" : "manual",
    ...(opts.mode ? { mode: opts.mode } : {}),
    judgeAgentId: opts.judgeAgentId ?? null,
    projectId: opts.projectId ?? null,
    // The EVAL gate is deliberately neutralised: a red-team verdict is decided
    // PER ATTACK CLASS below. Letting the aggregate eval gate also render a
    // verdict would mean two gates disagreeing about the same run.
    tolerance: 1,
    minScore: null,
    minPassRate: null,
    note: opts.note ?? null,
    purpose: RED_TEAM_ORIGIN_TAG,
    originDetail: { redteamLibrary: library.name, redteamLibraryVersion: library.version },
    ...(opts.judge ? { judge: opts.judge } : {}),
  });
  if (!evalOutcome.ok) {
    return {
      ok: false,
      status: evalOutcome.status,
      error: evalOutcome.error,
      ...(evalOutcome.detail ? { detail: evalOutcome.detail } : {}),
      ...(evalOutcome.decision ? { decision: evalOutcome.decision } : {}),
    };
  }

  const evalRun = evalOutcome.run;
  const results = await db.select().from(evalResults).where(eq(evalResults.runId, evalRun.id));
  const cases = await db
    .select()
    .from(evalCases)
    .where(
      and(
        eq(evalCases.datasetId, library.evalDatasetId),
        eq(evalCases.datasetVersion, library.evalDatasetVersion ?? 1),
      ),
    );
  const keyByCaseId = new Map(cases.map((c) => [c.id, probeKeyFromTags(c.tags)]));

  const outcomes: RedTeamProbeOutcome[] = [];
  const defeats: Array<{ probe: RedTeamProbeRow; score: number; resultId: string; output: string | null; detail: unknown }> = [];
  for (const r of results) {
    const key = r.caseId ? keyByCaseId.get(r.caseId) : null;
    const probe = key ? probeByKey.get(key) : undefined;
    if (!probe) continue;
    // POLARITY. The eval `passed` means the oracle found no disclosure, which
    // in red-team terms means the agent RESISTED. Stated once, here.
    const resisted = r.passed;
    outcomes.push({
      probeKey: probe.probeKey,
      attackClass: probe.attackClass,
      severity: probe.severity,
      score: r.score,
      resisted,
    });
    if (!resisted) {
      defeats.push({ probe, score: r.score, resultId: r.id, output: r.outputText, detail: r.detail });
    }
  }

  const classes = aggregateRedTeamByClass(outcomes);
  const overall = redTeamOverallAggregate(outcomes);
  const gatingClasses = opts.gatingClasses ?? RED_TEAM_ATTACK_CLASSES;
  const baseline = await resolveRedTeamBaseline(db, {
    libraryId: library.id,
    agentId: opts.agentId,
  });
  const gate = evaluateRedTeamGate({
    current: classes,
    baseline: baseline ? classAggregatesOf(baseline) : null,
    gatingClasses,
    tolerance: opts.tolerance ?? 0.05,
    minScore: opts.minScore ?? null,
    minResistRate: opts.minResistRate ?? null,
    failOnSeverity: opts.failOnSeverity ?? null,
    requireBaseline: opts.requireBaseline ?? false,
  });

  const [run] = await db
    .insert(redteamRuns)
    .values({
      libraryId: library.id,
      libraryName: library.name,
      libraryVersion: library.version,
      evalRunId: evalRun.id,
      agentId: evalRun.agentId,
      agentName: evalRun.agentName,
      model: evalRun.model,
      systemPromptHash: evalRun.systemPromptHash,
      initiatedByUserId: opts.userId,
      projectId: opts.projectId ?? null,
      trigger: opts.trigger,
      probes: overall.cases,
      resisted: overall.passedCases,
      defeated: overall.failedCases,
      resistRate: overall.passRate,
      meanScore: overall.meanScore,
      classSummary: classes as unknown[],
      gatingClasses: [...gatingClasses],
      baselineRunId: baseline?.id ?? null,
      gatePassed: gate.passed,
      regression: gate.regression,
      gateReason: gate.reason,
      costUsd: evalRun.costUsd,
      note: opts.note ?? null,
      finishedAt: new Date(),
    })
    .returning();

  if (defeats.length > 0) {
    await db.insert(redteamFindings).values(
      defeats.map((d) => ({
        runId: run!.id,
        probeId: d.probe.id,
        probeKey: d.probe.probeKey,
        attackClass: d.probe.attackClass,
        severity: d.probe.severity,
        score: d.score,
        evalResultId: d.resultId,
        outputSnippet: d.output ? d.output.slice(0, 2000) : null,
        detail: {
          libraryName: library.name,
          libraryVersion: library.version,
          scorer: d.probe.scorerKind,
          evidence: d.detail,
        },
      })),
    );
  }

  // ONE audit row per red-team run, into the SINGLE audit log. `eval_run` is
  // the object type on purpose: this IS an eval run, read for security.
  await db.insert(auditLog).values({
    userId: opts.userId,
    objectType: "eval_run",
    objectId: evalRun.id,
    detail: {
      phase: "redteam",
      purpose: RED_TEAM_ORIGIN_TAG,
      redteamRunId: run!.id,
      libraryName: library.name,
      libraryVersion: library.version,
      agentId: evalRun.agentId,
      agentName: evalRun.agentName,
      systemPromptHash: evalRun.systemPromptHash,
      trigger: opts.trigger,
      probes: overall.cases,
      defeated: overall.failedCases,
      resistRate: overall.passRate,
      gatingClasses: [...gatingClasses],
      baselineRunId: baseline?.id ?? null,
      regression: gate.regression,
      findings: defeats.length,
      classes: classes.map((c) => ({
        attackClass: c.attackClass,
        defeated: c.defeated,
        worstDefeatedSeverity: c.worstDefeatedSeverity,
      })),
    },
    effect: gate.passed ? "allow" : "deny",
    ruleId: gate.passed ? "redteam-run-passed" : gate.regression ? "redteam-regression" : "redteam-run-failed",
    ruleChain: [],
    reason: gate.reason,
  });

  return { ok: true, run: run!, classes, gate, findings: defeats.length, baseline };
}

// ---------------------------------------------------------------------------
// ADR-0057 — THE SCHEDULED SWEEP
// ---------------------------------------------------------------------------

export const REDTEAM_SWEEP_NOTE =
  "The sweep re-probes every (published library × agent) pair that has ALREADY been probed at least " +
  "once, as the user who ran the most recent probe of that pair — so it never exceeds that person's " +
  "entitlements and never mints an identity of its own. It does NOT invent new pairs: a library nobody " +
  "has ever pointed at an agent is not something a timer should start pointing. A pair whose last " +
  "initiator is gone is SKIPPED and said so. Driven by ADR-0064's scheduler when it is on, and by this " +
  "endpoint otherwise. Green still never means safe — see the coverage disclosure.";

export interface RedTeamSweepResult {
  ran: Array<{ libraryId: string; agentId: string; runId: string; regression: boolean; gatePassed: boolean | null }>;
  skipped: Array<{ libraryId: string; agentId: string | null; reason: string }>;
}

/**
 * ONE PASS of ADR-0057's "continuous" red teaming.
 *
 * ADR-0057 accepted the `scheduled` trigger and then disclosed that nothing
 * drives it — "continuous" meant "an operator or cron". ADR-0064 supplies the
 * driver. This function adds NO probing logic: it decides WHICH pairs to
 * re-probe and hands each to `runRedTeamSuite` — the same function
 * `POST /v1/redteam/runs` calls, which itself goes through `runEvalSuite` and
 * therefore through the ordinary governed dispatch core.
 *
 * IT ONLY RE-PROBES WHAT A HUMAN ALREADY CHOSE TO PROBE. Enumerating every
 * library against every agent would have a timer start spending money and
 * sending adversarial prompts at pairings nobody selected. The prior-run set is
 * the record of human intent, and the sweep stays inside it.
 */
export async function runScheduledRedTeamSweep(
  db: Db,
  dataKey: string | undefined,
): Promise<RedTeamSweepResult> {
  const published = await db
    .select()
    .from(redteamLibraries)
    .where(eq(redteamLibraries.status, "published"));
  const publishedIds = new Set(published.map((l) => l.id));

  // newest first, so the FIRST row seen for a pair is its most recent probe —
  // and therefore the identity the sweep inherits
  const prior = await db.select().from(redteamRuns).orderBy(desc(redteamRuns.startedAt));

  const ran: RedTeamSweepResult["ran"] = [];
  const skipped: RedTeamSweepResult["skipped"] = [];
  const seen = new Set<string>();

  for (const run of prior) {
    if (!publishedIds.has(run.libraryId)) continue;
    if (!run.agentId) continue;
    const key = `${run.libraryId}:${run.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!run.initiatedByUserId) {
      skipped.push({
        libraryId: run.libraryId,
        agentId: run.agentId,
        reason:
          "the last probe's initiating user is gone — the sweep will not send adversarial prompts as " +
          "somebody else, so run this pair manually once to re-establish whose authority it uses",
      });
      continue;
    }

    const outcome = await runRedTeamSuite(db, dataKey, {
      libraryId: run.libraryId,
      agentId: run.agentId,
      userId: run.initiatedByUserId,
      trigger: "scheduled",
      ...(Array.isArray(run.gatingClasses) && run.gatingClasses.length
        ? { gatingClasses: run.gatingClasses as RedTeamAttackClass[] }
        : {}),
      note: "ADR-0057 scheduled sweep",
    });
    if (!outcome.ok) {
      skipped.push({
        libraryId: run.libraryId,
        agentId: run.agentId,
        reason: `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      });
      continue;
    }
    ran.push({
      libraryId: run.libraryId,
      agentId: run.agentId,
      runId: outcome.run.id,
      regression: outcome.run.regression === true,
      gatePassed: outcome.run.gatePassed,
    });
  }
  return { ran, skipped };
}

// ---------------------------------------------------------------------------
// Admin + run API
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });

export interface RedTeamRouteOptions {
  dataKey?: string;
}

export function registerRedTeamRoutes(app: FastifyInstance, db: Db, opts: RedTeamRouteOptions = {}) {
  /** the attack-class registry — each class's summary next to what it CANNOT
   * tell you, rendered verbatim in the admin screen */
  app.get("/v1/redteam/attack-classes", async () => ({
    attackClasses: redTeamAttackClassRegistry(),
    severities: ["low", "medium", "high", "critical"],
    disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    // ADR-0064: 'continuous' now has a driver — when this deployment has one
    // switched on. Whether it does is reported, never assumed.
    scheduling: {
      schedulerEnabled: resolveSchedulerConfig().enabled,
      posture: resolveSchedulerConfig().reason,
      note: REDTEAM_SWEEP_NOTE,
    },
  }));

  /**
   * THE SWEEP, as an ENDPOINT. ADR-0064's in-process scheduler drives the SAME
   * function when it is switched on; this is the manual/on-demand door.
   */
  app.post("/v1/redteam/scheduled-sweep", async () => {
    const result = await runScheduledRedTeamSweep(db, opts.dataKey);
    return { ...result, note: REDTEAM_SWEEP_NOTE, disclosure: RED_TEAM_COVERAGE_DISCLOSURE };
  });

  app.get("/v1/redteam/libraries", async () => {
    const rows = await db
      .select()
      .from(redteamLibraries)
      .orderBy(asc(redteamLibraries.name), desc(redteamLibraries.version));
    const counts = await db
      .select({ libraryId: redteamProbes.libraryId, n: sql<number>`count(*)::int` })
      .from(redteamProbes)
      .groupBy(redteamProbes.libraryId);
    const map = new Map(counts.map((c) => [c.libraryId, c.n]));
    return {
      libraries: rows.map((l) => ({ ...l, probeCount: map.get(l.id) ?? 0, frozen: l.status === "published" })),
      note:
        "A library version freezes on PUBLISH, because publish is the moment it becomes an eval dataset a " +
        "result can be stamped against. Adding attacks is a data update, never a redeploy.",
    };
  });

  app.post("/v1/redteam/libraries", async (req, reply) => {
    const body = createRedTeamLibrarySchema.parse(req.body);
    const [existing] = await db
      .select({ n: count() })
      .from(redteamLibraries)
      .where(eq(redteamLibraries.name, body.name));
    if ((existing?.n ?? 0) > 0) return reply.status(409).send({ error: "library_name_taken" });
    const [row] = await db
      .insert(redteamLibraries)
      .values({
        name: body.name,
        version: 1,
        note: body.note ?? null,
        status: "draft",
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  /** install the shipped corpus. Idempotent — a second call returns the
   * existing library rather than a duplicate. */
  app.post("/v1/redteam/libraries/seed", async (req, reply) => {
    const { library, created } = await seedBuiltinRedTeamLibrary(db, req.authCtx.userId ?? null);
    const [n] = await db
      .select({ n: count() })
      .from(redteamProbes)
      .where(eq(redteamProbes.libraryId, library.id));
    return reply.status(created ? 201 : 200).send({
      library,
      probes: n?.n ?? 0,
      created,
      disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    });
  });

  app.get("/v1/redteam/libraries/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [library] = await db.select().from(redteamLibraries).where(eq(redteamLibraries.id, id));
    if (!library) return reply.status(404).send({ error: "unknown_library" });
    const probes = await db
      .select()
      .from(redteamProbes)
      .where(eq(redteamProbes.libraryId, id))
      .orderBy(asc(redteamProbes.attackClass), asc(redteamProbes.probeKey));
    const versions = await db
      .select({ id: redteamLibraries.id, version: redteamLibraries.version, status: redteamLibraries.status })
      .from(redteamLibraries)
      .where(eq(redteamLibraries.name, library.name))
      .orderBy(desc(redteamLibraries.version));
    return {
      library,
      probes,
      versions,
      frozen: library.status === "published",
      coverage: RED_TEAM_ATTACK_CLASSES.map((c) => ({
        attackClass: c,
        probes: probes.filter((p) => p.attackClass === c).length,
      })),
      disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    };
  });

  app.post("/v1/redteam/libraries/:id/probes", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = createRedTeamProbeSchema.parse(req.body);
    const [library] = await db.select().from(redteamLibraries).where(eq(redteamLibraries.id, id));
    if (!library) return reply.status(404).send({ error: "unknown_library" });
    if (library.status === "published") {
      return reply.status(409).send({
        error: "library_frozen",
        detail: `'${library.name}' v${library.version} has been published and is immutable — POST /v1/redteam/libraries/${library.id}/versions to mint the next version, then edit that`,
      });
    }
    // AN ORACLE THAT CANNOT FLAG IS REFUSED HERE, at authoring time. A probe
    // whose scorer passes every possible output reads as coverage and provides
    // none, which is strictly worse than an absent probe.
    const bad = validateRedTeamProbe({
      attackClass: body.attackClass,
      severity: body.severity,
      scorerKind: body.scorerKind as EvalScorerKind,
      scorerConfig: body.scorerConfig as EvalScorerConfig,
      expected: body.expected ?? null,
    });
    if (bad) return reply.status(422).send({ error: "unusable_probe_oracle", detail: bad });
    const [dupe] = await db
      .select({ n: count() })
      .from(redteamProbes)
      .where(and(eq(redteamProbes.libraryId, id), eq(redteamProbes.probeKey, body.probeKey)));
    if ((dupe?.n ?? 0) > 0) return reply.status(409).send({ error: "probe_key_taken" });
    const [row] = await db
      .insert(redteamProbes)
      .values({
        libraryId: id,
        probeKey: body.probeKey,
        attackClass: body.attackClass,
        severity: body.severity,
        input: body.input,
        scorerKind: body.scorerKind,
        scorerConfig: body.scorerConfig as Record<string, unknown>,
        expected: (body.expected ?? null) as never,
        note: body.note ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  /** mint version N+1, COPYING the probes. The only way to change a published
   * library — the old version keeps standing behind every result it scored. */
  app.post("/v1/redteam/libraries/:id/versions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [library] = await db.select().from(redteamLibraries).where(eq(redteamLibraries.id, id));
    if (!library) return reply.status(404).send({ error: "unknown_library" });
    const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${redteamLibraries.version}), 0)::int` })
      .from(redteamLibraries)
      .where(eq(redteamLibraries.name, library.name));
    const [next] = await db
      .insert(redteamLibraries)
      .values({
        name: library.name,
        version: (maxRow?.max ?? library.version) + 1,
        note: body.note ?? library.note,
        status: "draft",
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    const probes = await db.select().from(redteamProbes).where(eq(redteamProbes.libraryId, library.id));
    if (probes.length > 0) {
      await db.insert(redteamProbes).values(
        probes.map((p) => ({
          libraryId: next!.id,
          probeKey: p.probeKey,
          attackClass: p.attackClass,
          severity: p.severity,
          input: p.input,
          scorerKind: p.scorerKind,
          scorerConfig: p.scorerConfig,
          expected: p.expected as never,
          note: p.note,
        })),
      );
    }
    return reply.status(201).send({
      library: next,
      copiedProbes: probes.length,
      note:
        "Re-scoring an already-promoted agent under this NEWER library version can surface a regression that " +
        "was invisible when it shipped — an attack it never faced. That does not retroactively un-promote it; " +
        "it raises a finding (ADR-0057 §7).",
    });
  });

  app.post("/v1/redteam/libraries/:id/publish", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await publishRedTeamLibrary(db, id, req.authCtx.userId ?? null);
    if (!out.ok) {
      return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    }
    return reply.status(201).send({
      library: out.library,
      datasetId: out.datasetId,
      cases: out.cases,
      note:
        "The library is now an ordinary ADR-0044 eval dataset. Bind it to an automated_check stage with the " +
        "existing `evals:` binding and a regression will park the workflow instance at blocked_on_check — " +
        "there is no separate red-team blocking mechanism, by design.",
    });
  });

  /**
   * TRIGGER A RUN. In NON_ADMIN_ROUTES for exactly the reason POST
   * /v1/evals/runs is: the gate is the caller's OWN agent entitlement, checked
   * inside `runEvalSuite` as an invoke would check it. A user who cannot invoke
   * the agent cannot probe it either.
   */
  app.post("/v1/redteam/runs", async (req, reply) => {
    const body = startRedTeamRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_run_redteam" });
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }
    const outcome = await runRedTeamSuite(db, opts.dataKey, {
      libraryId: body.libraryId,
      agentId: body.agentId,
      userId,
      trigger: body.trigger,
      mode: body.mode,
      judgeAgentId: body.judgeAgentId ?? null,
      projectId: body.projectId ?? null,
      ...(body.gatingClasses ? { gatingClasses: body.gatingClasses } : {}),
      tolerance: body.tolerance,
      minScore: body.minScore ?? null,
      minResistRate: body.minResistRate ?? null,
      failOnSeverity: body.failOnSeverity ?? null,
      requireBaseline: body.requireBaseline,
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
      classes: outcome.classes,
      gate: outcome.gate,
      findings: outcome.findings,
      baselineRunId: outcome.baseline?.id ?? null,
      disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    });
  });

  app.get("/v1/redteam/runs", async (req) => {
    const q = z
      .object({
        agentId: z.string().uuid().optional(),
        libraryId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = await db
      .select()
      .from(redteamRuns)
      .where(
        and(
          q.agentId ? eq(redteamRuns.agentId, q.agentId) : undefined,
          q.libraryId ? eq(redteamRuns.libraryId, q.libraryId) : undefined,
        ),
      )
      .orderBy(desc(redteamRuns.startedAt))
      .limit(q.limit);
    return { runs: rows, disclosure: RED_TEAM_COVERAGE_DISCLOSURE };
  });

  app.get("/v1/redteam/runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [run] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_redteam_run" });
    const findings = await db
      .select()
      .from(redteamFindings)
      .where(eq(redteamFindings.runId, run.id))
      .orderBy(asc(redteamFindings.attackClass), asc(redteamFindings.probeKey));
    const [evalRun] = await db.select().from(evalRuns).where(eq(evalRuns.id, run.evalRunId));
    const evidence = await db
      .select({ id: modelCardEvidence.id, cardId: modelCardEvidence.cardId, label: modelCardEvidence.label })
      .from(modelCardEvidence)
      .where(eq(modelCardEvidence.evalRunId, run.evalRunId));
    let baseline: RedTeamRunRow | null = null;
    if (run.baselineRunId) {
      const [b] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, run.baselineRunId));
      baseline = b ?? null;
    }
    return {
      run,
      classes: run.classSummary,
      findings,
      /** the governed, metered, audited eval run that produced every number
       * above — a red-team verdict is never detachable from its transcripts */
      evalRun: evalRun ?? null,
      baseline,
      modelCardEvidence: evidence,
      disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    };
  });

  /**
   * ATTACH THIS RUN AS MODEL-CARD EVIDENCE (ADR-0045 §5). It writes into the
   * EXISTING `model_card_evidence` table with `kind = 'eval_run'` and the SAME
   * audit ruleId the MRM route uses — there is deliberately no second evidence
   * store, so a reviewer reading a model card sees red-team evidence and
   * quality evidence in one list.
   */
  app.post("/v1/redteam/runs/:id/evidence", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = attachRedTeamEvidenceSchema.parse(req.body);
    const [run] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_redteam_run" });
    const [card] = await db.select().from(modelCards).where(eq(modelCards.id, body.cardId));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const [dupe] = await db
      .select({ id: modelCardEvidence.id })
      .from(modelCardEvidence)
      .where(
        and(eq(modelCardEvidence.cardId, body.cardId), eq(modelCardEvidence.evalRunId, run.evalRunId)),
      );
    if (dupe) return reply.status(409).send({ error: "evidence_already_attached" });
    const [row] = await db
      .insert(modelCardEvidence)
      .values({
        cardId: body.cardId,
        kind: "eval_run",
        evalRunId: run.evalRunId,
        externalRef: null,
        label:
          body.label ??
          `red-team '${run.libraryName}' v${run.libraryVersion}: ${run.defeated}/${run.probes} probe(s) defeated`,
        note:
          body.note ??
          `${run.gateReason ?? ""} — ${RED_TEAM_COVERAGE_DISCLOSURE}`.trim(),
        attachedByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "model_card",
      objectId: body.cardId,
      detail: {
        phase: "evidence",
        action: "attached",
        evidenceId: row!.id,
        kind: "eval_run",
        evalRunId: run.evalRunId,
        redteamRunId: run.id,
        defeated: run.defeated,
        probes: run.probes,
      },
      effect: "allow",
      ruleId: "mrm-evidence-attached",
      ruleChain: [],
      reason:
        `an ADR-0057 red-team run ('${run.libraryName}' v${run.libraryVersion}, ${run.defeated} of ${run.probes} ` +
        "probes defeated) was attached as measured evidence behind this risk position",
    });
    return reply.status(201).send({ evidence: row });
  });

  /** the posture view the admin screen opens on: what got through recently,
   * ranked by severity, with who ran it */
  app.get("/v1/redteam/summary", async () => {
    const runs = await db.select().from(redteamRuns).orderBy(desc(redteamRuns.startedAt)).limit(200);
    const runIds = runs.map((r) => r.id);
    const findings = runIds.length
      ? await db.select().from(redteamFindings).where(inArray(redteamFindings.runId, runIds))
      : [];
    const userRows = await db.select({ id: users.id, email: users.email }).from(users);
    const emails = new Map(userRows.map((u) => [u.id, u.email]));
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byClass: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byClass[f.attackClass] = (byClass[f.attackClass] ?? 0) + 1;
    }
    return {
      runs: runs.length,
      regressions: runs.filter((r) => r.regression).length,
      failed: runs.filter((r) => r.gatePassed === false).length,
      findings: findings.length,
      bySeverity,
      byClass,
      totalCostUsd: Number(runs.reduce((a, r) => a + r.costUsd, 0).toFixed(6)),
      recent: runs.slice(0, 25).map((r) => ({
        id: r.id,
        agentName: r.agentName,
        libraryName: r.libraryName,
        libraryVersion: r.libraryVersion,
        trigger: r.trigger,
        probes: r.probes,
        defeated: r.defeated,
        resistRate: r.resistRate,
        gatePassed: r.gatePassed,
        regression: r.regression,
        startedAt: r.startedAt,
        by: r.initiatedByUserId ? (emails.get(r.initiatedByUserId) ?? null) : null,
      })),
      disclosure: RED_TEAM_COVERAGE_DISCLOSURE,
    };
  });

  /** every defeat still standing, newest first — the one list a security
   * reviewer reads. A RECORD, not a queue: there is no status to change here,
   * because remediation is a workflow and a sign-off is an approval. */
  app.get("/v1/redteam/findings", async (req) => {
    const q = z
      .object({
        attackClass: z.enum(RED_TEAM_ATTACK_CLASSES).optional(),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const rows = await db
      .select({
        finding: redteamFindings,
        agentName: redteamRuns.agentName,
        libraryName: redteamRuns.libraryName,
        libraryVersion: redteamRuns.libraryVersion,
        startedAt: redteamRuns.startedAt,
      })
      .from(redteamFindings)
      .innerJoin(redteamRuns, eq(redteamRuns.id, redteamFindings.runId))
      .where(
        and(
          q.attackClass ? eq(redteamFindings.attackClass, q.attackClass) : undefined,
          q.severity ? eq(redteamFindings.severity, q.severity) : undefined,
        ),
      )
      .orderBy(desc(redteamRuns.startedAt))
      .limit(q.limit);
    return { findings: rows, disclosure: RED_TEAM_COVERAGE_DISCLOSURE };
  });
}
