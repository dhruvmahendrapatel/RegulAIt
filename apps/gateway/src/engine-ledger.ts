/**
 * ADR-0187 B5-E — NORMALISATION INTO THE EXISTING LEDGERS.
 *
 * A COMPLETED engine run against an agent lands in the same records the
 * in-process red-team and evals write, so A3 (required tests, ADR-0180 §4), the
 * evaluator catalog and the Red-teaming and Evaluations pages read it with no
 * second code path:
 *   - one `eval_runs` row (the engine's anchor dataset `engine:<id>` v1, the
 *     configuration hash the run measured, status completed, the server's own
 *     counts) and, for a red-team engine, one `redteam_runs` row on it with the
 *     server-recomputed ASR, Wilson interval and measurement quality;
 *   - one `redteam_probe_trials` row per attempt of each MAPPED item (unknown
 *     and not-run items as one errored trial: excluded from every denominator);
 *   - one `eval_results` row per mapped scorer item that passed or failed.
 *
 * Only completed runs are written here (the caller checks), and only mapped
 * items reach the probe-trial and result rows: "a completed run counts only for
 * the classes it actually measured", and an unmapped or unknown item counts
 * toward nothing. No model text is copied: the engine never sends any, and the
 * strings that are copied (item keys, reasons) were scrubbed at ingest.
 */
import { createHash } from "node:crypto";
import {
  and,
  agents,
  eq,
  evalDatasets,
  evalResults,
  evalRuns,
  redteamLibraries,
  redteamProbeTrials,
  redteamRuns,
  type Db,
  type EngineRunRow,
} from "@regulait/db";
import { aggregateRedTeamByClass, RED_TEAM_MAX_TRIALS, RED_TEAM_SEVERITIES, type EngineKind, type EngineRunNormalised, type RedTeamSeverity } from "@regulait/shared";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** the engine's anchor dataset and library (created on first use, one per engine) */
async function ensureEngineAnchors(tx: Tx, engineId: string, version: string): Promise<{ datasetId: string; libraryId: string; libraryName: string }> {
  const name = `engine:${engineId}`;
  await tx
    .insert(evalDatasets)
    .values({ name, version: 1, note: `ADR-0187: the anchor for results of the ${engineId} engine (no cases; the engine holds its own corpus)` })
    .onConflictDoNothing();
  const [ds] = await tx.select({ id: evalDatasets.id }).from(evalDatasets).where(and(eq(evalDatasets.name, name), eq(evalDatasets.version, 1)));
  await tx
    .insert(redteamLibraries)
    .values({
      name,
      version: 1,
      status: "published",
      evalDatasetId: ds!.id,
      evalDatasetVersion: 1,
      publishedAt: new Date(),
      note: `ADR-0187: results of the ${engineId} engine (${version} at first use); probes live in the engine, not here`,
    })
    .onConflictDoNothing();
  const [lib] = await tx.select({ id: redteamLibraries.id }).from(redteamLibraries).where(and(eq(redteamLibraries.name, name), eq(redteamLibraries.version, 1)));
  return { datasetId: ds!.id, libraryId: lib!.id, libraryName: name };
}

const isSeverity = (s: string): s is RedTeamSeverity => (RED_TEAM_SEVERITIES as readonly string[]).includes(s);

/**
 * Write a completed agent-target run into the eval and red-team ledgers.
 * Returns the ids written (both null when the target agent is gone).
 */
export async function writeEngineRunLedgers(
  tx: Tx,
  args: { run: EngineRunRow; kind: EngineKind; normalised: EngineRunNormalised; finishedAt: Date },
): Promise<{ evalRunId: string | null; redteamRunId: string | null }> {
  const { run, normalised, kind, finishedAt } = args;
  if (run.targetKind !== "agent" || !run.targetAgentId || kind === "model_scan") return { evalRunId: null, redteamRunId: null };
  const [agent] = await tx.select().from(agents).where(eq(agents.id, run.targetAgentId));
  if (!agent) return { evalRunId: null, redteamRunId: null };
  const anchors = await ensureEngineAnchors(tx, run.engineId, run.engineVersion);
  const promptHash = agent.systemPrompt ? createHash("sha256").update(agent.systemPrompt).digest("hex").slice(0, 16) : null;
  const scored = normalised.items.filter((i) => i.scorerKind !== null && (i.verdict === "pass" || i.verdict === "fail"));
  // PR #203 review [11]: the eval run's cases are what was MEASURED against a
  // mapped class or scorer — never an unmapped, unknown or not-run item
  const measuredItems = normalised.items.filter(
    (i) => (i.attackClass !== null || i.scorerKind !== null) && (i.verdict === "pass" || i.verdict === "fail"),
  );
  const cases = measuredItems.length;
  const passedCases = measuredItems.filter((i) => i.verdict === "pass").length;
  const [ev] = await tx
    .insert(evalRuns)
    .values({
      datasetId: anchors.datasetId,
      datasetVersion: 1,
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model ?? null,
      tier: agent.tier,
      systemPromptHash: promptHash,
      judgeAgentId: run.judgeAgentId,
      judgeImpl: `engine:${run.engineId}@${run.engineVersion}`,
      trigger: run.trigger,
      status: "completed",
      mode: "execute",
      initiatedByUserId: run.runAsUserId,
      projectId: run.projectId,
      workflowInstanceId: run.workflowInstanceId,
      workflowStageId: run.workflowStageId,
      workflowCheckName: run.workflowCheckName,
      cases,
      passedCases,
      passRate: cases > 0 ? passedCases / cases : null,
      meanScore: scored.length ? scored.filter((i) => i.verdict === "pass").length / scored.length : null,
      costUsd: run.costUsd,
      gatePassed: normalised.verdict === "pass",
      regression: false,
      gateReason: normalised.explanation,
      configHash: run.agentConfigHash,
      note: `engine run ${run.id} (${run.engineId} ${run.engineVersion})`,
      finishedAt,
    })
    .returning({ id: evalRuns.id });
  const resultRows = scored.map((it) => ({
    runId: ev!.id,
    caseId: null,
    scorerKind: it.scorerKind!,
    score: it.verdict === "pass" ? 1 : 0,
    passed: it.verdict === "pass",
    outputText: null,
    detail: { engineRunId: run.id, engineItemKey: it.key, attempts: it.attempts, defeated: it.defeated },
  }));
  for (let i = 0; i < resultRows.length; i += 500) await tx.insert(evalResults).values(resultRows.slice(i, i + 500));
  if (kind !== "redteam") return { evalRunId: ev!.id, redteamRunId: null };

  const measured = normalised.probeStats.filter((p) => p.status === "measured");
  const defeatedProbes = measured.filter((p) => p.defeats > 0).length;
  const [rt] = await tx
    .insert(redteamRuns)
    .values({
      libraryId: anchors.libraryId,
      libraryName: anchors.libraryName,
      libraryVersion: 1,
      evalRunId: ev!.id,
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model ?? null,
      systemPromptHash: promptHash,
      initiatedByUserId: run.runAsUserId,
      projectId: run.projectId,
      trigger: run.trigger,
      probes: measured.length,
      resisted: measured.length - defeatedProbes,
      defeated: defeatedProbes,
      resistRate: measured.length ? (measured.length - defeatedProbes) / measured.length : null,
      // the in-process shape (aggregateRedTeamByClass), over MEASURED mapped probes only,
      // so the evaluator catalog reads it the same way; the pooled ASR rides probeStats
      classSummary: aggregateRedTeamByClass(
        measured.map((p) => ({ probeKey: p.probeKey, attackClass: p.attackClass, severity: p.severity, score: p.meanScore ?? 0, resisted: p.defeats === 0 })),
      ),
      gatingClasses: [],
      costUsd: run.costUsd,
      trials: normalised.trialsPerProbe > 0 ? Math.min(normalised.trialsPerProbe, 25) : 1,
      asr: normalised.asr,
      asrLower: normalised.asrInterval?.lower ?? null,
      asrUpper: normalised.asrInterval?.upper ?? null,
      asrTrials: normalised.asrTrials,
      measurementQuality: normalised.measurementQuality,
      notRunProbes: normalised.probeStats.length - measured.length,
      probeStats: normalised.probeStats,
      note: `engine run ${run.id} (${run.engineId} ${run.engineVersion}, taxonomy v${normalised.taxonomyVersion})`,
      startedAt: run.leasedAt ?? run.createdAt,
      finishedAt,
    })
    .returning({ id: redteamRuns.id });
  // one row per attempt, at most RED_TEAM_MAX_TRIALS per probe (defeats come first, so a cap never hides one)
  const byKey = new Map(normalised.items.map((i) => [i.key, i]));
  const trialRows: Array<typeof redteamProbeTrials.$inferInsert> = [];
  for (const p of normalised.probeStats) {
    const item = byKey.get(p.probeKey);
    if (!item || !item.attackClass || !isSeverity(item.severity)) continue;
    for (const o of p.outcomes.slice(0, RED_TEAM_MAX_TRIALS)) {
      trialRows.push({
        runId: rt!.id,
        probeKey: p.probeKey,
        attackClass: item.attackClass,
        severity: item.severity,
        trial: o.trial,
        defeated: o.defeated,
        score: o.score,
        // an errored trial carries the engine's (scrubbed) reason; a scored trial has none
        error: o.error === null ? null : item.reason ? `${o.error}: ${item.reason}`.slice(0, 1000) : o.error,
        turnsDispatched: 1,
        outputSnippet: null,
        adjudication: { engineRunId: run.id, engine: run.engineId, sourceId: item.sourceId },
      });
    }
  }
  for (let i = 0; i < trialRows.length; i += 500) await tx.insert(redteamProbeTrials).values(trialRows.slice(i, i + 500));
  return { evalRunId: ev!.id, redteamRunId: rt!.id };
}
