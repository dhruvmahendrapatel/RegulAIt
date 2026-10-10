/**
 * ADR-0187 decision 190 — THE APPROVAL HOLD FOR AN OFFENSIVE BUILT-IN DATASET.
 *
 * Decision 9's rule for engine sets, applied to eval datasets: a run of a set
 * classed offensive (today: the CyberSecEval interpreter set) waits in the one
 * approvals queue while the org's sensitive-set approval is on (the same
 * strict-by-default dial, `engineSensitiveSetApproval`).
 *
 * The consent is bound to the run request (`evalRunApprovalDigest`: dataset
 * version, agent, judge or panel, project, mode and gate thresholds), so an
 * approval for one agent or judge never releases another. The flow is the
 * re-submit pattern the held connector write uses: the first submission
 * queues (202, nothing runs); once approved, the SAME person re-submitting the
 * identical request spends the approval exactly once, inside the runner, after
 * every other check and immediately before the run row is written.
 *
 * The approver is the one named on the request or the org's default approver,
 * never the person the run executes as (403 `caller_cannot_approve`).
 */
import { and, approvals, asc, auditLog, eq, evalDatasets, gt, isNull, or, sql, users, type Db } from "@regulait/db";
import { builtinEvalDatasetByName, evalRunApprovalDigest, type startEvalRunSchema } from "@regulait/shared";
import type { z } from "zod";
import { isBuiltinEvalDataset } from "./eval-builtin-datasets.js";
import { loadOrgSettings } from "./org-settings.js";

type StartBody = z.infer<typeof startEvalRunSchema>;

export type HoldOutcome =
  | { kind: "pass" }
  | { kind: "reply"; status: number; body: Record<string, unknown> }
  | { kind: "release"; approval: { approvalId: string; consume: () => Promise<boolean> } };

const unexpired = () => or(isNull(approvals.expiresAt), gt(approvals.expiresAt, sql`now()`));

export async function holdOffensiveBuiltinRun(db: Db, body: StartBody, userId: string): Promise<HoldOutcome> {
  const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, body.datasetId));
  // an unknown dataset, a user dataset, and a retired built-in are the runner's to refuse
  if (!dataset || !isBuiltinEvalDataset(dataset)) return { kind: "pass" };
  const spec = builtinEvalDatasetByName(dataset.name);
  if (!spec || spec.version !== dataset.version || spec.sensitivity !== "offensive") return { kind: "pass" };
  const org = await loadOrgSettings(db);
  if (!org.engineSensitiveSetApproval) return { kind: "pass" };

  const digest = evalRunApprovalDigest({
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    agentId: body.agentId,
    judgeAgentId: body.judgeAgentId ?? null,
    judgePanel: body.judgePanel ?? null,
    repetitions: body.repetitions,
    projectId: body.projectId ?? null,
    mode: body.mode,
    tolerance: body.tolerance,
    minScore: body.minScore ?? null,
    minPassRate: body.minPassRate ?? null,
    baselineRunId: body.baselineRunId ?? null,
  });
  const mine = and(eq(approvals.userId, userId), eq(approvals.objectType, "eval_run"), eq(approvals.argumentsDigest, digest));

  const [approved] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(mine, eq(approvals.status, "approved"), unexpired()))
    .orderBy(asc(approvals.requestedAt))
    .limit(1);
  if (approved) {
    return {
      kind: "release",
      approval: {
        approvalId: approved.id,
        consume: async () => {
          const spent = await db
            .update(approvals)
            .set({ status: "consumed" })
            .where(and(eq(approvals.id, approved.id), eq(approvals.status, "approved"), unexpired()))
            .returning({ id: approvals.id });
          return spent.length === 1;
        },
      },
    };
  }

  const pendingReply = (approvalId: string, reused: boolean) => ({
    kind: "reply" as const,
    status: 202,
    body: {
      status: "pending_approval",
      approvalId,
      reused,
      error: "eval_run_approval_required",
      detail:
        `${dataset.name} is an offensive built-in dataset; approval '${approvalId}' is pending and nothing ran. ` +
        "Re-submit the identical request once it is approved.",
    },
  });
  const [pending] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(mine, eq(approvals.status, "pending"), unexpired()))
    .orderBy(asc(approvals.requestedAt))
    .limit(1);
  if (pending) return pendingReply(pending.id, true);

  const approverUserId = body.approverUserId ?? org.infraApproverUserId ?? null;
  if (!approverUserId) {
    return {
      kind: "reply",
      status: 422,
      body: {
        error: "eval_run_approver_required",
        detail: `${dataset.name} is an offensive built-in dataset, so a run waits for approval: name approverUserId, or set a default approver in org settings`,
      },
    };
  }
  if (approverUserId === userId) {
    return { kind: "reply", status: 403, body: { error: "caller_cannot_approve", detail: "the person a run executes as cannot approve it" } };
  }
  const [approver] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
  if (!approver || approver.disabledAt) return { kind: "reply", status: 404, body: { error: "unknown_approver" } };

  const approvalId = await db.transaction(async (tx) => {
    const [a] = await tx
      .insert(approvals)
      .values({
        userId,
        objectType: "eval_run",
        approverUserId,
        projectId: body.projectId ?? null,
        stageId: `__eval_run__:${dataset.id}`,
        argumentsDigest: digest,
        argumentsPreview: {
          dataset: dataset.name,
          datasetVersion: dataset.version,
          sensitivity: spec.sensitivity,
          agentId: body.agentId,
          judgeAgentId: body.judgeAgentId ?? null,
          judgePanel: body.judgePanel ?? null,
          projectId: body.projectId ?? null,
          cases: spec.range[1] - spec.range[0],
        },
        argumentsPreviewKind: "arguments_v1",
        approvalScope: "action",
        status: "pending",
        ...(org.approvalTtlHours != null ? { expiresAt: new Date(Date.now() + org.approvalTtlHours * 3_600_000) } : {}),
      })
      .returning({ id: approvals.id });
    await tx.insert(auditLog).values({
      userId,
      objectType: "eval_run",
      objectId: dataset.id,
      detail: {
        phase: "builtin-dataset-approval",
        builtinDataset: spec.key,
        sensitivity: spec.sensitivity,
        approvalId: a!.id,
        approverUserId,
        agentId: body.agentId,
        judgeAgentId: body.judgeAgentId ?? null,
        projectId: body.projectId ?? null,
        requestDigest: digest,
      },
      effect: "require_approval",
      ruleId: "eval-run-queued-for-approval",
      ruleChain: [],
      reason: `run of offensive built-in dataset ${dataset.name} queued for approval; nothing runs until it is approved`,
    });
    return a!.id;
  });
  return pendingReply(approvalId, false);
}
