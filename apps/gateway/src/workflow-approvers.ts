/**
 * ADR-0195 A4 (owner question Q1, decided by the master session under ADR-0180) — a sign-off by SOMEONE OTHER than
 * the initiator.
 *
 * A `human_approval` stage's `approvers` are named user ids or the `requesting_user` placeholder. This adds one
 * more placeholder, `admin_not_initiator`: at the stage it resolves to one approval row per active org admin other
 * than the initiator, and the decide path refuses the initiator on that stage whatever route they come by (named
 * approver, delegate or admin override). With the stage's quorum `any`, one other admin's approval advances it.
 * The approval itself is the existing queue: no new decision mechanism.
 *
 * This module imports no route module, so the workflow routes and the decide path can both call it.
 */
import { and, eq, isNull, ne, users, type Db } from "@regulait/db";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";

/** the approver placeholder for "an org admin who is not the initiator" */
export const APPROVER_ADMIN_NOT_INITIATOR = "admin_not_initiator";

/** the active admins who may sign off a stage this initiator started (never the initiator) */
export async function adminsOtherThan(db: Db, initiatorUserId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, initiatorUserId)));
  return rows.map((r) => r.id).sort();
}

/** whether a stage of this definition must be signed off by someone other than its initiator */
export function stageExcludesInitiator(definition: WorkflowDefinition | null | undefined, stageId: string | null): boolean {
  const stage = definition?.stages.find((s) => s.id === stageId);
  return (stage?.approvers ?? []).includes(APPROVER_ADMIN_NOT_INITIATOR);
}

/** whether any stage of this definition needs a second person */
export function definitionNeedsSecondApprover(definition: WorkflowDefinition): boolean {
  return definition.stages.some((s) => (s.approvers ?? []).includes(APPROVER_ADMIN_NOT_INITIATOR));
}

/**
 * whether starting this definition must be refused because its sign-off is owed by an admin other than the
 * initiator and none exists: the stage could never be decided. Both start paths (the one instance-creation path and
 * the shadow-AI default's install) ask this one question
 */
export async function secondApproverMissing(db: Db, definition: WorkflowDefinition, initiatorUserId: string): Promise<boolean> {
  return definitionNeedsSecondApprover(definition) && (await adminsOtherThan(db, initiatorUserId)).length === 0;
}
