/**
 * ADR-0245 — ADR-0217's automatic re-test, for SIDECAR ENGINE runs (garak, promptfoo, spikee, PyRIT).
 *
 * An engine run is asynchronous: the sweep can only queue it (`createEngineRun`, through every gate a person's run
 * passes: entitlement, project, budget, approvals). So a re-test of kind `engine` is claimed `running` with the engine
 * run it started (`engine_run_id`), and it is SETTLED here, in the same transaction that ends that engine run, from
 * the gateway's own normalised verdict (never the engine's claim):
 *
 *   completed, verdict fail                         → failed_gate
 *   completed, verdict pass, at least one measured  → passed
 *   completed otherwise (unknown, nothing measured) → reported
 *   refused in the Approvals Queue                  → refused
 *   timeout, cancelled, failed, not_run             → reported, with the run's end as the reason (never a pass)
 *
 * This module imports only the database package, so `engine-runs.ts` can call it without a cycle.
 */
import { and, auditLog, eq, isNull, modelCardApprovals, mrmRetestRuns, sql, type Db, type MrmRetestRunRow } from "@regulait/db";

/** the slice of a transaction this needs (the gateway's `Tx` is one) */
type RetestTx = Pick<Db, "select" | "update" | "insert">;

/** the sentinel the MRM code uses when the re-test's person is gone */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export interface EngineRunEnd {
  engineRunId: string;
  engineId: string;
  status: string;
  errorCode: string | null;
  /** the gateway's normalised verdict, or null when the run produced none */
  verdict: "pass" | "fail" | "unknown" | "not_run" | null;
  /** items measured with a usable verdict (pass or fail) */
  measured: number;
  asr: number | null;
  redteamRunId: string | null;
  evalRunId: string | null;
}

/** the re-test status an engine run's end becomes (pure; the table above) */
export function engineRetestStatus(end: Pick<EngineRunEnd, "status" | "errorCode" | "verdict" | "measured">): { status: MrmRetestRunRow["status"]; reason: string | null } {
  if (end.status === "completed") {
    if (end.verdict === "fail") return { status: "failed_gate", reason: "the engine run found at least one attack that succeeded" };
    if (end.verdict === "pass" && end.measured > 0) return { status: "passed", reason: null };
    return { status: "reported", reason: "the engine run completed without a measured verdict" };
  }
  if (end.errorCode === "approval_denied") return { status: "refused", reason: "the re-test's engine run was refused in the Approvals Queue" };
  return { status: "reported", reason: `the re-test's engine run ended ${end.status}${end.errorCode ? ` (${end.errorCode})` : ""}; nothing was measured as a pass` };
}

/**
 * Settle the re-test this engine run belongs to, if any, in the caller's transaction (the one that ends the run).
 * Only a `running` row moves, so a second end of the same run (which the run's own status guards anyway) is a no-op.
 */
export async function settleEngineRetestTx(tx: RetestTx, end: EngineRunEnd): Promise<MrmRetestRunRow | null> {
  const settled = engineRetestStatus(end);
  const [row] = await tx
    .update(mrmRetestRuns)
    .set({
      status: settled.status,
      reason: settled.reason,
      redteamRunId: end.redteamRunId,
      evalRunId: end.evalRunId,
      summary: { engineId: end.engineId, engineStatus: end.status, verdict: end.verdict, measured: end.measured, asr: end.asr },
      // M-075: the database clock, as the engine run's own end is stamped
      finishedAt: sql`now()`,
    })
    .where(and(eq(mrmRetestRuns.engineRunId, end.engineRunId), eq(mrmRetestRuns.kind, "engine"), eq(mrmRetestRuns.status, "running")))
    .returning();
  if (!row) return null;
  // as the synchronous kinds: one still unattached joins the card's pending re-certification request
  const [open] = await tx
    .select({ id: modelCardApprovals.id })
    .from(modelCardApprovals)
    .where(and(eq(modelCardApprovals.cardId, row.cardId), eq(modelCardApprovals.status, "pending")));
  if (open) {
    await tx
      .update(mrmRetestRuns)
      .set({ cardApprovalId: open.id })
      .where(and(eq(mrmRetestRuns.id, row.id), isNull(mrmRetestRuns.cardApprovalId)));
  }
  await tx.insert(auditLog).values({
    userId: row.runAsUserId ?? NO_IDENTITY,
    objectType: "model_card",
    objectId: row.cardId,
    detail: {
      phase: "auto_retest",
      action: "finished",
      retestId: row.id,
      status: settled.status,
      engineRunId: end.engineRunId,
      evalRunId: end.evalRunId,
      redteamRunId: end.redteamRunId,
    },
    effect: settled.status === "refused" ? "deny" : "allow",
    ruleId: "mrm-auto-retest-finished",
    ruleChain: [],
    reason: `automatic re-test of '${row.sourceName}' ${settled.status.replace("_", " ")}${settled.reason ? `: ${settled.reason}` : ""}`,
  });
  return row;
}
