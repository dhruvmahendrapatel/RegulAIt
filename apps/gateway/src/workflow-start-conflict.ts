/**
 * ADR-0349 slice 2 (lane E30, an idea borrowed from Temporal's workflow-id reuse policy): at most one OPEN workflow
 * instance per start key, the routed template set + `change.targetSystem` + the work item the start names.
 *
 * - Without a work item there is no identity to deduplicate on, and nothing here applies.
 * - The database enforces it: the partial unique index `workflow_instances_open_start_uq` (an instance that ends
 *   frees its key). The read here answers the common case with the existing instance; a race between two starts
 *   ends in one unique violation, which the start answers the same way.
 * - Refused by default (ADR-0180): 409 `workflow_start_conflict`, audited `workflow:start-conflict` (deny).
 *   `org_settings.workflow_start_conflict_policy = 'use_existing'` (a `settings_relax` step-up, audited by the
 *   strictness registry) answers with the open instance instead, audited `workflow:start-reused`.
 * - Object-level authorisation: the existing instance's id, status and state go only to a caller who may read it
 *   (an admin or its initiator). Anyone else gets the 409 without them, under either policy.
 */
import { and, auditLog, eq, sql, workflowInstances, type Db } from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";

export const WORKFLOW_START_KEY_INDEX = "workflow_instances_open_start_uq";

const TERMINAL = ["completed", "aborted", "denied", "rolled_back"] as const;

export interface StartKey {
  templateIds: readonly string[];
  targetSystem: string | null;
  workItemRef: string;
}

export function startKeyOf(templateIds: readonly string[], change: Record<string, unknown>, workItemRef: string): StartKey {
  const target = change.targetSystem;
  return { templateIds, targetSystem: typeof target === "string" ? target : null, workItemRef };
}

/** the open instance holding this start key, if any (served by `workflow_instances_open_start_uq`) */
export async function openInstanceForStartKey(db: Db, key: StartKey) {
  const [row] = await db
    .select({
      id: workflowInstances.id,
      status: workflowInstances.status,
      state: workflowInstances.state,
      initiatorUserId: workflowInstances.initiatorUserId,
    })
    .from(workflowInstances)
    .where(
      and(
        sql`${workflowInstances.templateIds} = ${JSON.stringify(key.templateIds)}::jsonb`,
        sql`(${workflowInstances.change}->>'targetSystem') IS NOT DISTINCT FROM ${key.targetSystem}`,
        eq(workflowInstances.workItemRef, key.workItemRef),
        sql`${workflowInstances.status} NOT IN (${sql.join(
          TERMINAL.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export type StartConflictOutcome =
  | { kind: "reused"; instance: { id: string; status: string; state: unknown } }
  | { kind: "refused"; status: 409; body: Record<string, unknown> };

/**
 * Answer a start whose key is held by `existing`, under the org's policy, and audit the answer. `existing` is null
 * only when the unique violation was seen but the holder ended before it could be read again: the caller retries
 * nothing and the start is refused with no instance named.
 */
export async function answerStartConflict(
  db: Db,
  key: StartKey,
  existing: Awaited<ReturnType<typeof openInstanceForStartKey>>,
  caller: { userId: string; isAdmin: boolean },
): Promise<StartConflictOutcome> {
  const policy = (await loadOrgSettings(db)).workflowStartConflictPolicy;
  const shown = existing !== null && (caller.isAdmin || existing.initiatorUserId === caller.userId) ? existing : null;
  const visible = shown !== null;
  const reuse = policy === "use_existing" && shown !== null;
  const detail = {
    templateIds: [...key.templateIds],
    targetSystem: key.targetSystem,
    workItem: key.workItemRef,
    policy,
    existingInstanceId: existing?.id ?? null,
    existingVisibleToCaller: visible,
  };
  await db.insert(auditLog).values({
    userId: caller.userId,
    objectType: "workflow",
    objectId: existing?.id ?? null,
    detail,
    effect: reuse ? "allow" : "deny",
    ruleId: reuse ? "workflow:start-reused" : "workflow:start-conflict",
    ruleChain: [],
    reason: reuse
      ? "a workflow start named a work item that already has an open instance of the same workflow and target; the org policy use_existing answered with that instance"
      : "a workflow start named a work item that already has an open instance of the same workflow and target, so no second instance was started",
  });
  if (reuse && shown) return { kind: "reused", instance: { id: shown.id, status: shown.status, state: shown.state } };
  return {
    kind: "refused",
    status: 409,
    body: {
      error: "workflow_start_conflict",
      ...(shown ? { existingInstanceId: shown.id, existingStatus: shown.status } : {}),
      detail: shown
        ? `work item '${key.workItemRef}' already has an open instance of this workflow for this target ` +
          `(${shown.id}): continue that instance, or abort it before starting a new one`
        : "this work item already has an open instance of this workflow for this target, started by someone else: ask " +
          "its initiator or an admin to continue or abort it",
    },
  };
}
