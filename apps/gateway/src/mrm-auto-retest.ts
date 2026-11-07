/**
 * ADR-0217 (P16) — AUTOMATIC RE-TEST AFTER A MODEL CHANGE.
 *
 * A model, prompt or endpoint change on a certified card's subject already counts as certification drift
 * (`computeCardStaleness`, ADR-0181 FX1), and with staleness-forces-recertification on it refuses dispatch until a
 * person signs off again. Before this, nothing re-measured the changed model: the eval-drift and red-team sweeps
 * only repeat pairs on their own schedule, and their results were not tied to the re-certification.
 *
 * With `mrmAutoRetestEnabled` on (off by default; turning it on is a stepped-up, audited relaxation), each pass:
 *  1. finds every certified agent card whose drift since certification includes a configuration change;
 *  2. picks the suites already chosen for that agent: each pinned eval baseline, and each published red-team
 *     library someone has probed it with (the same "a human already chose this pair" rule as the sweeps), at most
 *     `MRM_AUTO_RETEST_MAX_SUITES` per drift;
 *  3. claims each (card, drift, suite) once, then runs it through `runEvalSuite` / `runRedTeamSuite` as the
 *     person who ran that suite before, billed to the same project. The ordinary dispatch core applies their
 *     entitlements, the project budget gate, usage attribution and the per-run caps. A project already over its
 *     budget is refused here before any call is made;
 *  4. attaches the result to the card's pending re-certification request, or to the next one requested.
 *
 * ADR-0245: a third kind, `engine`. Each completed red-team ENGINE run a person ran against the agent (garak,
 * promptfoo, spikee, PyRIT; one per engine and configuration, newest first, never a run a re-test started) is
 * created again through `createEngineRun` as that person, on that project, with the same sets, judge, trials and
 * budget, so every gate a person's run passes applies (entitlement, project, budget, approvals). An engine run is
 * asynchronous, so the re-test stays `running` and is settled when the run ends (mrm-retest-engine.ts).
 *
 * It NEVER signs anything off and never clears drift: the card stays stale, and dispatch stays refused, until a
 * person decides the request in the Approvals Queue. A re-test that regresses or fails its gate is itself drift,
 * like any server-started run.
 */
import {
  and,
  auditLog,
  desc,
  eq,
  engineRuns,
  evalDatasets,
  evalRuns,
  isNotNull,
  isNull,
  sql,
  modelCardApprovals,
  modelCards,
  mrmRetestRuns,
  redteamLibraries,
  redteamRuns,
  type Db,
  type ModelCardRow,
  type MrmRetestRunRow,
  users,
} from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";
import { computeCardStaleness } from "./mrm-autofill.js";
import { runEvalSuite } from "./evals.js";
import { runRedTeamSuite } from "./redteam.js";
import { preDispatchProjectGate } from "./projects.js";
import { errMessage } from "./err-serializer.js";
import { createEngineRun } from "./engine-runs.js";
import { settleEngineRetestTx, type EngineRunEnd } from "./mrm-retest-engine.js";
import { ENGINE_MANIFEST, SCORING_SEMANTICS_VERSION, createEngineRunSchema, type EngineId, type RedTeamAttackClass } from "@regulait/shared";

/** the audit row's subject when the suite's last runner is gone (the same sentinel the MRM routes use) */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** the most suites one drift of one card re-runs; the rest are reported as skipped */
export const MRM_AUTO_RETEST_MAX_SUITES = 10;

export { MRM_AUTO_RETEST_NOTE } from "./mrm-retest-store.js";

interface Suite {
  kind: "eval" | "redteam" | "engine";
  sourceId: string;
  sourceName: string;
  runAsUserId: string | null;
  projectId: string | null;
  gatingClasses?: RedTeamAttackClass[];
  tolerance?: number;
  minScore?: number | null;
  minPassRate?: number | null;
  trials?: number;
  /** kind engine: the stored request of the run repeated (validated again before use) */
  engineRequest?: unknown;
}

export interface MrmAutoRetestResult {
  enabled: boolean;
  cards: Array<{ cardId: string; driftKey: string; runs: Array<Pick<MrmRetestRunRow, "id" | "kind" | "sourceId" | "status" | "reason">> }>;
}

/** the suites already chosen for this agent, newest first, one per dataset or library */
async function suitesFor(db: Db, agentId: string): Promise<Suite[]> {
  const baselines = await db
    .select({ run: evalRuns, name: evalDatasets.name })
    .from(evalRuns)
    .innerJoin(evalDatasets, eq(evalDatasets.id, evalRuns.datasetId))
    .where(and(eq(evalRuns.agentId, agentId), eq(evalRuns.isBaseline, true), eq(evalRuns.status, "completed")))
    .orderBy(desc(evalRuns.startedAt));
  // a red-team run's backing eval row is never itself pinned as an eval baseline, but exclude it by id anyway
  const probed = await db
    .select({ run: redteamRuns })
    .from(redteamRuns)
    .innerJoin(redteamLibraries, eq(redteamLibraries.id, redteamRuns.libraryId))
    .where(and(eq(redteamRuns.agentId, agentId), eq(redteamLibraries.status, "published")))
    .orderBy(desc(redteamRuns.startedAt));
  const backing = new Set(probed.map((p) => p.run.evalRunId));
  const out: Suite[] = [];
  const seen = new Set<string>();
  for (const { run, name } of baselines) {
    if (backing.has(run.id) || seen.has(`eval:${run.datasetId}`)) continue;
    // ADR-0072: a pin scored under older semantics is not comparable; the drift sweep reports it, so do we
    if (run.scoringSemantics !== SCORING_SEMANTICS_VERSION) continue;
    seen.add(`eval:${run.datasetId}`);
    out.push({
      kind: "eval",
      sourceId: run.datasetId,
      sourceName: name,
      runAsUserId: run.initiatedByUserId,
      projectId: run.projectId,
      tolerance: run.tolerance,
      minScore: run.minScore,
      minPassRate: run.minPassRate,
    });
  }
  for (const { run } of probed) {
    if (seen.has(`redteam:${run.libraryId}`)) continue;
    seen.add(`redteam:${run.libraryId}`);
    out.push({
      kind: "redteam",
      sourceId: run.libraryId,
      sourceName: run.libraryName,
      runAsUserId: run.initiatedByUserId,
      projectId: run.projectId,
      trials: run.trials,
      ...(Array.isArray(run.gatingClasses) && run.gatingClasses.length
        ? { gatingClasses: run.gatingClasses as RedTeamAttackClass[] }
        : {}),
    });
  }
  // ADR-0245: the red-team engine runs a person ran against this agent, one per engine and configuration, newest first;
  // a run a re-test started is never itself a source (the claim's source must stay the person's choice)
  const engineDone = await db
    .select({ run: engineRuns })
    .from(engineRuns)
    .where(
      and(
        eq(engineRuns.targetAgentId, agentId),
        eq(engineRuns.targetKind, "agent"),
        eq(engineRuns.status, "completed"),
        sql`NOT EXISTS (SELECT 1 FROM ${mrmRetestRuns} WHERE ${mrmRetestRuns.engineRunId} = ${engineRuns.id})`,
      ),
    )
    .orderBy(desc(engineRuns.createdAt), desc(engineRuns.id));
  for (const { run } of engineDone) {
    const manifest = ENGINE_MANIFEST[run.engineId as EngineId];
    if (!manifest || manifest.kind !== "redteam") continue;
    if (seen.has(`engine:${run.engineId}:${run.configHash}`)) continue;
    seen.add(`engine:${run.engineId}:${run.configHash}`);
    out.push({
      kind: "engine",
      sourceId: run.id,
      sourceName: `${manifest.displayName}: ${run.config.sets.join(", ")}`.slice(0, 300),
      runAsUserId: run.runAsUserId,
      projectId: run.projectId,
      trials: run.trials,
      engineRequest: {
        engineId: run.engineId,
        target: { agentId, ...(run.judgeAgentId ? { judgeAgentId: run.judgeAgentId } : {}) },
        config: run.config,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        budgetUsd: run.budgetUsd,
        trials: run.trials,
      },
    });
  }
  return out;
}

/** a pass only on the runner's own passing gate over at least one case; no verdict, or nothing measured, is
 * `reported`, never a pass (the red-team runner passes a run that exercised no gating class, as a report) */
function verdict(gatePassed: boolean | null, regression: boolean | null, measured: number): MrmRetestRunRow["status"] {
  if (gatePassed === false || regression === true) return "failed_gate";
  return gatePassed === true && measured > 0 ? "passed" : "reported";
}

type Finish = Pick<MrmRetestRunRow, "status" | "reason"> &
  Partial<Pick<MrmRetestRunRow, "evalRunId" | "redteamRunId" | "engineRunId" | "summary">>;

async function runSuite(db: Db, dataKey: string | undefined, card: ModelCardRow, suite: Suite, origin: Record<string, unknown>): Promise<Finish> {
  if (!suite.runAsUserId) {
    return {
      status: "skipped",
      reason: "the person who last ran this suite is gone; a re-test never runs as somebody else",
    };
  }
  // pillar 5: a project already over its budget is refused before any call; the dispatch core re-checks per call
  const gate = await preDispatchProjectGate(db, suite.projectId, suite.runAsUserId);
  if (!gate.ok) return { status: "refused", reason: `${gate.error}${gate.detail ? `: ${gate.detail}` : ""}` };
  const note = "automatic re-test after a model change";
  if (suite.kind === "engine") return queueEngineRetest(db, suite);
  if (suite.kind === "eval") {
    const outcome = await runEvalSuite(db, dataKey, {
      datasetId: suite.sourceId,
      agentId: card.agentId!,
      userId: suite.runAsUserId,
      trigger: "scheduled",
      ...(suite.projectId ? { projectId: suite.projectId } : {}),
      ...(suite.tolerance !== undefined ? { tolerance: suite.tolerance } : {}),
      ...(suite.minScore != null ? { minScore: suite.minScore } : {}),
      ...(suite.minPassRate != null ? { minPassRate: suite.minPassRate } : {}),
      note,
      originDetail: origin,
    });
    if (!outcome.ok) return { status: "refused", reason: `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}` };
    const r = outcome.run;
    return {
      status: verdict(r.gatePassed, r.regression, r.cases),
      reason: r.gateReason ?? null,
      evalRunId: r.id,
      summary: { gatePassed: r.gatePassed, regression: r.regression, meanScore: r.meanScore, passRate: r.passRate },
    };
  }
  const outcome = await runRedTeamSuite(db, dataKey, {
    libraryId: suite.sourceId,
    agentId: card.agentId!,
    userId: suite.runAsUserId,
    trigger: "scheduled",
    ...(suite.projectId ? { projectId: suite.projectId } : {}),
    ...(suite.gatingClasses ? { gatingClasses: suite.gatingClasses } : {}),
    ...(suite.trials ? { trials: suite.trials } : {}),
    note,
  });
  if (!outcome.ok) return { status: "refused", reason: `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}` };
  const r = outcome.run;
  return {
    status: verdict(r.gatePassed, r.regression, r.probes),
    reason: r.gateReason ?? null,
    evalRunId: r.evalRunId,
    redteamRunId: r.id,
    summary: { gatePassed: r.gatePassed, regression: r.regression, meanScore: r.meanScore, asr: r.asr, probes: r.probes },
  };
}

/**
 * ADR-0245: queue the engine run a re-test of kind `engine` waits on. The stored request is validated again (an
 * engine's set grammar or the agent may have changed), and the person must still exist and be active; the run is
 * created as them, so their entitlements, the project and the approvals rule apply as to their own run. The result
 * is `running` with the new run's id; the run's end settles it (mrm-retest-engine.ts).
 */
async function queueEngineRetest(db: Db, suite: Suite): Promise<Finish> {
  const [person] = await db.select({ id: users.id, disabledAt: users.disabledAt, isAdmin: users.isAdmin }).from(users).where(eq(users.id, suite.runAsUserId!));
  if (!person || person.disabledAt) return { status: "skipped", reason: "the person who last ran this engine run is gone or deactivated; a re-test never runs as somebody else" };
  const parsed = createEngineRunSchema.safeParse(suite.engineRequest);
  if (!parsed.success) return { status: "refused", reason: "the repeated engine run's request is no longer valid" };
  const created = await createEngineRun(db, parsed.data, { runAsUserId: person.id, isAdmin: person.isAdmin, trigger: "scheduled" });
  if (!created.ok) return { status: "refused", reason: `${created.error}${created.detail ? `: ${created.detail}` : ""}` };
  return { status: "running", reason: null, engineRunId: created.run.id };
}

/** ONE PASS. Driven by the `mrm-auto-retest-sweep` scheduler job; a no-op while the setting is off. */
export async function runMrmAutoRetestSweep(db: Db, dataKey: string | undefined, now: Date = new Date()): Promise<MrmAutoRetestResult> {
  const org = await loadOrgSettings(db);
  if (!org.mrmAutoRetestEnabled) return { enabled: false, cards: [] };
  const cards = await db.select().from(modelCards).where(isNotNull(modelCards.agentId));
  const result: MrmAutoRetestResult = { enabled: true, cards: [] };
  for (const card of cards) {
    const chain = await db
      .select()
      .from(modelCardApprovals)
      .where(eq(modelCardApprovals.cardId, card.id))
      .orderBy(desc(modelCardApprovals.requestedAt));
    const staleness = await computeCardStaleness(db, card, chain, now);
    const changes = staleness.driftSinceCertification?.configChanges ?? 0;
    if (!staleness.certified || changes === 0) continue;
    const driftKey = `${staleness.lastCertifiedAt}|config:${changes}`;
    const pending = chain.find((a) => a.status === "pending") ?? null;
    const suites = await suitesFor(db, card.agentId!);
    const entry: MrmAutoRetestResult["cards"][number] = { cardId: card.id, driftKey, runs: [] };
    for (const [i, suite] of suites.entries()) {
      const over = i >= MRM_AUTO_RETEST_MAX_SUITES;
      // the claim and its audit row in one transaction; a suite already claimed for this drift is not re-run
      const claimed = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(mrmRetestRuns)
          .values({
            cardId: card.id,
            driftKey,
            kind: suite.kind,
            sourceId: suite.sourceId,
            sourceName: suite.sourceName,
            runAsUserId: suite.runAsUserId,
            projectId: suite.projectId,
            status: over ? "skipped" : "running",
            reason: over ? `more than ${MRM_AUTO_RETEST_MAX_SUITES} suites for one change; run the rest by hand` : null,
            cardApprovalId: pending?.id ?? null,
            ...(over ? { finishedAt: now } : {}),
          })
          .onConflictDoNothing({ target: [mrmRetestRuns.cardId, mrmRetestRuns.driftKey, mrmRetestRuns.kind, mrmRetestRuns.sourceId] })
          .returning();
        if (!row) return null;
        await tx.insert(auditLog).values({
          userId: suite.runAsUserId ?? NO_IDENTITY,
          objectType: "model_card",
          objectId: card.id,
          detail: { phase: "auto_retest", action: over ? "skipped" : "queued", retestId: row.id, driftKey, kind: suite.kind, sourceId: suite.sourceId, modelCardApprovalId: row.cardApprovalId },
          effect: "allow",
          ruleId: "mrm-auto-retest-queued",
          ruleChain: [],
          reason: `${over ? "skipped" : "queued"} an automatic ${suite.kind === "eval" ? "eval" : suite.kind === "engine" ? "engine" : "red-team"} re-test of '${suite.sourceName}' after a model change on model card '${card.intendedUse}'`,
        });
        return row;
      });
      if (!claimed) continue;
      if (over) {
        entry.runs.push({ id: claimed.id, kind: claimed.kind, sourceId: claimed.sourceId, status: claimed.status, reason: claimed.reason });
        continue;
      }
      let finish: Finish;
      try {
        finish = await runSuite(db, dataKey, card, suite, { mrmRetest: { cardId: card.id, retestId: claimed.id } });
      } catch (err) {
        finish = { status: "refused", reason: `the runner failed: ${errMessage(err)}` };
      }
      if (suite.kind === "engine" && finish.status === "running" && finish.engineRunId) {
        const engineRunId = finish.engineRunId;
        const linked = await db.transaction(async (tx) => {
          // the engine run's row lock orders this link against the run's own end (which takes the same lock): either
          // the run is still live and its end will settle this row, or it already ended and is settled here
          const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, engineRunId)).for("update");
          const [row] = await tx.update(mrmRetestRuns).set({ engineRunId }).where(eq(mrmRetestRuns.id, claimed.id)).returning();
          await tx.insert(auditLog).values({
            userId: suite.runAsUserId ?? NO_IDENTITY,
            objectType: "model_card",
            objectId: card.id,
            detail: { phase: "auto_retest", action: "engine_run_started", retestId: claimed.id, engineRunId },
            effect: "allow",
            ruleId: "mrm-auto-retest-engine-run-started",
            ruleChain: [],
            reason: `automatic re-test of '${suite.sourceName}' started engine run ${engineRunId}; it settles when that run ends`,
          });
          if (run && run.finishedAt) {
            const sum = (run.summary ?? {}) as { verdict?: EngineRunEnd["verdict"]; counts?: { pass?: number; fail?: number }; asr?: number | null };
            return (
              (await settleEngineRetestTx(tx, {
                engineRunId,
                engineId: run.engineId,
                status: run.status,
                errorCode: run.errorCode,
                verdict: sum.verdict ?? null,
                measured: (sum.counts?.pass ?? 0) + (sum.counts?.fail ?? 0),
                asr: sum.asr ?? null,
                redteamRunId: run.redteamRunId,
                evalRunId: run.evalRunId,
              })) ?? row
            );
          }
          return row;
        });
        entry.runs.push({ id: linked!.id, kind: linked!.kind, sourceId: linked!.sourceId, status: linked!.status, reason: linked!.reason });
        continue;
      }
      const [done] = await db.transaction(async (tx) => {
        // a request created while the suite ran attached this row already; one still unattached joins a pending one
        const [open] = await tx
          .select({ id: modelCardApprovals.id })
          .from(modelCardApprovals)
          .where(and(eq(modelCardApprovals.cardId, card.id), eq(modelCardApprovals.status, "pending")));
        const rows = await tx
          .update(mrmRetestRuns)
          .set({ ...finish, finishedAt: new Date() })
          .where(eq(mrmRetestRuns.id, claimed.id))
          .returning();
        if (open) {
          await tx
            .update(mrmRetestRuns)
            .set({ cardApprovalId: open.id })
            .where(and(eq(mrmRetestRuns.id, claimed.id), isNull(mrmRetestRuns.cardApprovalId)));
        }
        await tx.insert(auditLog).values({
          userId: suite.runAsUserId ?? NO_IDENTITY,
          objectType: "model_card",
          objectId: card.id,
          detail: { phase: "auto_retest", action: "finished", retestId: claimed.id, status: finish.status, evalRunId: finish.evalRunId ?? null, redteamRunId: finish.redteamRunId ?? null },
          effect: finish.status === "refused" ? "deny" : "allow",
          ruleId: "mrm-auto-retest-finished",
          ruleChain: [],
          reason: `automatic re-test of '${suite.sourceName}' ${finish.status.replace("_", " ")}${finish.reason ? `: ${finish.reason}` : ""}`,
        });
        return rows;
      });
      entry.runs.push({ id: done!.id, kind: done!.kind, sourceId: done!.sourceId, status: done!.status, reason: done!.reason });
    }
    result.cards.push(entry);
  }
  return result;
}
