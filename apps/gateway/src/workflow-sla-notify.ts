/**
 * ADR-0340 slice 2 — the courier a workflow stage deadline notifies through. chatops.ts registers the guarded chat
 * courier for a database handle (as it does for governance alerts, ADR-0162, and the alert SLA sweep, ADR-0182 S5);
 * a deployment without ChatOps posts nothing, and the in-app record (the `sla:<stage>` marker on the instance, the
 * audit rows, the pending sign-off in the approvals queue) is unaffected. Its own module so chatops.ts and
 * workflows.ts both reach it without importing each other.
 *
 * The notice carries no change content: the instance and stage ids, the phase and a fixed text. The card links to
 * the instance, where reading it needs a sign-in and the instance's own authorisation.
 */
import type { Db } from "@regulait/db";

export interface WorkflowSlaNotice {
  instanceId: string;
  stageId: string;
  /** a reminder before the deadline, or the breach itself */
  phase: "warn" | "breach";
  /** what the breach did (`notify` for a reminder) */
  action: "notify" | "fail";
  /** the people the notice is for (the instance's initiator); they are mailed by resend */
  recipientUserIds: string[];
  dueAt: string | null;
}

export type WorkflowSlaCourier = (notice: WorkflowSlaNotice) => Promise<{ posted: number; failed: number }>;
const couriers = new WeakMap<object, WorkflowSlaCourier>();

export function registerWorkflowSlaCourier(db: Db, courier: WorkflowSlaCourier): void {
  couriers.set(db as object, courier);
}

/** post a deadline notice through the registered courier; nothing registered = nothing posted */
export async function notifyWorkflowSla(db: Db, notice: WorkflowSlaNotice): Promise<{ posted: number; failed: number; courier: boolean }> {
  const courier = couriers.get(db as object);
  if (!courier) return { posted: 0, failed: 0, courier: false };
  return { ...(await courier(notice)), courier: true };
}

/** the notice's one-line, content-free text */
export function workflowSlaNoticeText(n: WorkflowSlaNotice): string {
  const at = `stage '${n.stageId}' of workflow instance ${n.instanceId.slice(0, 8)}`;
  if (n.phase === "warn") return `Reminder: ${at} is due${n.dueAt ? ` at ${n.dueAt}` : " soon"}.`;
  if (n.action === "fail") return `Deadline missed: ${at} was cancelled by its SLA (compensations, if any, are running).`;
  return `Deadline missed: ${at} is overdue.`;
}
