/**
 * ADR-0076 — COST RECONCILIATION, the gateway half.
 *
 *   `packages/shared/src/cost-reconciliation.ts`  the planner. Pure: decides
 *                                                 which lines restate the same
 *                                                 vendor fact, refuses
 *                                                 ambiguity, reports overlaps.
 *   THIS FILE                                     persistence, the run ledger,
 *                                                 the admin API, the audit
 *                                                 rows, and the ADR-0064 job
 *                                                 body.
 *
 * THE INVARIANT THIS FILE EXISTS TO GUARANTEE
 * -------------------------------------------
 * After a reconciliation pass, a consolidated read never counts the same
 * vendor line twice — and NOTHING was deleted to get there. A duplicate is
 * MARKED (`superseded_at` + a reason + the line that replaced it + the run
 * that decided it), the consolidated response DISCLOSES how many marked lines
 * it excluded, and every mark is audited. The older row stays forever: it is
 * the evidence of what the older file said and of what every
 * pre-reconciliation read reported.
 *
 * THE TWO REFUSALS, RESTATED: batches that disagree about a fact's
 * multiplicity are reported and left alone; overlapping-but-not-identical
 * windows are reported and left alone. A reconciliation that guesses is a
 * chargeback nobody can defend — the operator's correction path is ADR-0069's
 * existing one: revoke the wrong batch, re-import the right file.
 *
 * ONE BODY, BOTH TRIGGERS. The ADR-0064 scheduler job and the admin "run now"
 * endpoint call the same `runCostReconciliation`, so a scheduled pass and a
 * manual one are the same code path by construction — the same pattern every
 * other sweep in scheduler-jobs.ts follows.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  costImportBatches,
  costReconciliationRuns,
  desc,
  eq,
  importedCostLines,
  inArray,
  isNotNull,
  isNull,
  sql,
  type Db,
} from "@regulait/db";
import { planCostReconciliation, type ReconciliationLineInput } from "@regulait/shared";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — the strings an operator greps the audit log for */
export const COST_RECONCILE_RULE_IDS = {
  passCompleted: "cost-reconcile-completed",
  passFailed: "cost-reconcile-failed",
  groupSuperseded: "cost-reconcile-superseded",
  linesReinstated: "cost-reconcile-reinstated",
} as const;

export const COST_RECONCILE_POSTURE =
  "Reconciliation marks cross-batch duplicates of the same vendor fact as superseded — it NEVER deletes a line, " +
  "and consolidated reads disclose how many marked lines they excluded. Batches that disagree about a fact's " +
  "multiplicity, and windows that overlap without being identical, are REPORTED and left alone: the correction " +
  "path for those is the operator's existing one — revoke the wrong batch and re-import. Revoking a batch whose " +
  "lines superseded older copies REINSTATES those older copies in the same transaction, so a withdrawn " +
  "restatement never silently erases the fact it restated.";

export interface CostReconciliationOutcome {
  runId: string;
  trigger: "manual" | "schedule";
  scannedLines: number;
  duplicateGroups: number;
  supersededLines: number;
  ambiguousGroups: number;
  overlapWarnings: number;
  warnings: Array<Record<string, unknown>>;
}

/**
 * One reconciliation pass. Opens its ledger row FIRST (a row stuck at
 * 'running' is the diagnosis of a process that died mid-pass), marks every
 * plannable duplicate, audits each group and the pass, and never deletes
 * anything.
 */
export async function runCostReconciliation(
  db: Db,
  opts: { actorUserId: string | null; now?: Date; trigger: "manual" | "schedule" },
): Promise<CostReconciliationOutcome> {
  const now = opts.now ?? new Date();
  const [run] = await db
    .insert(costReconciliationRuns)
    .values({ trigger: opts.trigger, initiatedByUserId: opts.actorUserId, startedAt: now })
    .returning();

  const audit = (ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId: opts.actorUserId ?? NIL_UUID,
      objectType: "cost_reconciliation_run",
      objectId: run!.id,
      detail: { subsystem: "cross-vendor-cost", trigger: opts.trigger, ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  try {
    // LIVE lines of APPLIED batches only: revoked batches have no lines, and a
    // line already marked in an earlier pass stays marked.
    const rows = await db
      .select({
        id: importedCostLines.id,
        batchId: importedCostLines.batchId,
        vendor: importedCostLines.vendor,
        accountKey: importedCostLines.accountKey,
        billingKind: importedCostLines.billingKind,
        service: importedCostLines.service,
        currency: importedCostLines.currency,
        periodStart: importedCostLines.periodStart,
        periodEnd: importedCostLines.periodEnd,
        amount: importedCostLines.amount,
        batchAppliedAt: costImportBatches.appliedAt,
        batchCreatedAt: costImportBatches.createdAt,
      })
      .from(importedCostLines)
      .innerJoin(costImportBatches, eq(importedCostLines.batchId, costImportBatches.id))
      .where(and(eq(costImportBatches.status, "applied"), isNull(importedCostLines.supersededAt)));

    const inputs: ReconciliationLineInput[] = rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      batchAppliedAt: (r.batchAppliedAt ?? r.batchCreatedAt).getTime(),
      vendor: r.vendor,
      accountKey: r.accountKey,
      billingKind: r.billingKind,
      service: r.service,
      currency: r.currency,
      periodStart: r.periodStart.getTime(),
      periodEnd: r.periodEnd.getTime(),
      amount: r.amount,
    }));

    const plan = planCostReconciliation(inputs);

    for (const group of plan.duplicateGroups) {
      for (const item of group.supersede) {
        await db
          .update(importedCostLines)
          .set({
            supersededAt: now,
            supersededByLineId: item.supersededByLineId,
            supersededRunId: run!.id,
            supersededReason: item.reason,
          })
          .where(eq(importedCostLines.id, item.lineId));
      }
      await audit(
        COST_RECONCILE_RULE_IDS.groupSuperseded,
        "allow",
        `marked ${group.supersede.length} line(s) as superseded duplicates of batch ${group.keptBatchId} ` +
          `(${group.vendor}/${group.accountKey}, ${group.periodStart.slice(0, 10)}..${group.periodEnd.slice(0, 10)}, ` +
          `${group.amount} ${group.currency}). Marked, never deleted; excluded from consolidated reads with the ` +
          `exclusion disclosed.`,
        {
          vendor: group.vendor,
          accountKey: group.accountKey,
          amount: group.amount,
          currency: group.currency,
          periodStart: group.periodStart,
          periodEnd: group.periodEnd,
          keptBatchId: group.keptBatchId,
          keptLineIds: group.keptLineIds,
          supersededLineIds: group.supersede.map((s) => s.lineId),
          supersededBatchIds: [...new Set(group.supersede.map((s) => s.batchId))],
        },
      );
    }

    const warnings = plan.warnings as unknown as Array<Record<string, unknown>>;
    const finishedAt = new Date();
    await db
      .update(costReconciliationRuns)
      .set({
        finishedAt,
        outcome: "ok",
        scannedLines: plan.scannedLines,
        duplicateGroups: plan.duplicateGroups.length,
        supersededLines: plan.supersededLineCount,
        ambiguousGroups: plan.ambiguousGroups,
        overlapWarnings: plan.overlapWarningCount,
        warnings,
      })
      .where(eq(costReconciliationRuns.id, run!.id));

    await audit(
      COST_RECONCILE_RULE_IDS.passCompleted,
      "allow",
      `cost reconciliation pass complete (${opts.trigger}): ${plan.scannedLines} live line(s) scanned, ` +
        `${plan.supersededLineCount} marked superseded across ${plan.duplicateGroups.length} duplicate group(s); ` +
        `${plan.ambiguousGroups} ambiguous group(s) and ${plan.overlapWarningCount} overlapping window(s) ` +
        `REPORTED and deliberately left alone.`,
      {
        scannedLines: plan.scannedLines,
        duplicateGroups: plan.duplicateGroups.length,
        supersededLines: plan.supersededLineCount,
        ambiguousGroups: plan.ambiguousGroups,
        overlapWarnings: plan.overlapWarningCount,
      },
    );

    return {
      runId: run!.id,
      trigger: opts.trigger,
      scannedLines: plan.scannedLines,
      duplicateGroups: plan.duplicateGroups.length,
      supersededLines: plan.supersededLineCount,
      ambiguousGroups: plan.ambiguousGroups,
      overlapWarnings: plan.overlapWarningCount,
      warnings,
    };
  } catch (err) {
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000);
    await db
      .update(costReconciliationRuns)
      .set({ finishedAt: new Date(), outcome: "failed", error: message })
      .where(eq(costReconciliationRuns.id, run!.id));
    await audit(COST_RECONCILE_RULE_IDS.passFailed, "deny", `cost reconciliation pass FAILED: ${message}`, {
      error: message,
    });
    throw err;
  }
}

/**
 * Called by the batch-revoke path BEFORE a batch's lines are deleted: any line
 * an about-to-be-deleted line had superseded comes back to life. A withdrawn
 * restatement must not silently erase the fact it restated — the older file's
 * assertion becomes the live one again, and the reinstatement is audited.
 */
export async function reinstateLinesSupersededBy(
  db: Db,
  opts: { batchId: string; lineIds: string[]; actorUserId: string | null; reason: string },
): Promise<number> {
  if (opts.lineIds.length === 0) return 0;
  const reinstated = await db
    .update(importedCostLines)
    .set({ supersededAt: null, supersededByLineId: null, supersededRunId: null, supersededReason: null })
    .where(inArray(importedCostLines.supersededByLineId, opts.lineIds))
    .returning({ id: importedCostLines.id, batchId: importedCostLines.batchId });
  if (reinstated.length > 0) {
    await db.insert(auditLog).values({
      userId: opts.actorUserId ?? NIL_UUID,
      objectType: "cost_reconciliation_run",
      objectId: null,
      detail: {
        subsystem: "cross-vendor-cost",
        revokedBatchId: opts.batchId,
        reinstatedLineIds: reinstated.map((r) => r.id),
        reinstatedFromBatchIds: [...new Set(reinstated.map((r) => r.batchId))],
      },
      effect: "allow",
      ruleId: COST_RECONCILE_RULE_IDS.linesReinstated,
      ruleChain: [],
      reason:
        `reinstated ${reinstated.length} older imported line(s) whose superseding copies are being withdrawn ` +
        `with batch ${opts.batchId} (${opts.reason}) — a revoked restatement must not silently erase the fact ` +
        `it restated.`,
    });
  }
  return reinstated.length;
}

/** the numbers the admin screen and the consolidated response disclose */
export async function costReconciliationStatus(db: Db) {
  const [counts] = await db
    .select({
      liveLines: sql<number>`count(*) filter (where ${importedCostLines.supersededAt} is null)::int`,
      supersededLines: sql<number>`count(*) filter (where ${importedCostLines.supersededAt} is not null)::int`,
    })
    .from(importedCostLines);
  const [lastOk] = await db
    .select()
    .from(costReconciliationRuns)
    .where(eq(costReconciliationRuns.outcome, "ok"))
    .orderBy(desc(costReconciliationRuns.startedAt))
    .limit(1);
  return {
    liveLines: counts?.liveLines ?? 0,
    supersededLines: counts?.supersededLines ?? 0,
    lastRun: lastOk ?? null,
  };
}

export function registerCostReconciliationRoutes(app: FastifyInstance, db: Db): void {
  /**
   * RUN NOW. Admin-only through app.ts's default-deny gate. The same function
   * the ADR-0064 job runs — a manual pass and a scheduled pass are one code
   * path.
   */
  app.post("/v1/cost-imports/reconcile", async (req) => {
    const outcome = await runCostReconciliation(db, {
      actorUserId: req.authCtx.userId ?? null,
      trigger: "manual",
    });
    return {
      ...outcome,
      posture: COST_RECONCILE_POSTURE,
      note: "This ran the same function the scheduled job runs.",
    };
  });

  /** THE HEALTH / REPORT READ: last pass, the standing counts, recent history,
   * and what was deliberately not touched. */
  app.get("/v1/cost-imports/reconciliation", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(10) })
      .parse(req.query ?? {});
    const status = await costReconciliationStatus(db);
    const recentRuns = await db
      .select()
      .from(costReconciliationRuns)
      .orderBy(desc(costReconciliationRuns.startedAt))
      .limit(q.limit);
    // superseded lines, listed (bounded) so "what exactly is excluded from my
    // consolidated view" is answerable without SQL
    const supersededSample = await db
      .select({
        id: importedCostLines.id,
        batchId: importedCostLines.batchId,
        vendor: importedCostLines.vendor,
        accountKey: importedCostLines.accountKey,
        amount: importedCostLines.amount,
        currency: importedCostLines.currency,
        periodStart: importedCostLines.periodStart,
        periodEnd: importedCostLines.periodEnd,
        supersededAt: importedCostLines.supersededAt,
        supersededByLineId: importedCostLines.supersededByLineId,
        supersededReason: importedCostLines.supersededReason,
      })
      .from(importedCostLines)
      .where(isNotNull(importedCostLines.supersededAt))
      .orderBy(desc(importedCostLines.supersededAt))
      .limit(100);
    return {
      ...status,
      recentRuns,
      supersededSample,
      supersededSampleTruncated: status.supersededLines > supersededSample.length,
      scheduler: {
        jobName: "cost-reconciliation-sweep",
        note:
          "The scheduled pass is an ADR-0064 job: it runs only while the in-process scheduler is on " +
          "(REGULAIT_SCHEDULER=on) and the job is enabled, and 'run now' here executes the identical function.",
      },
      posture: COST_RECONCILE_POSTURE,
    };
  });
}
