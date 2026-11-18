/** ADR-0352: work-item priority, independent of approval/consent state. */
import { defineMachine } from "./state-machine.js";

export const APPROVAL_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ApprovalPriority = (typeof APPROVAL_PRIORITIES)[number];
export type ApprovalPriorityEvent = `set_${ApprovalPriority}`;

export const APPROVAL_PRIORITY_MACHINE = defineMachine<ApprovalPriority, ApprovalPriorityEvent>({
  id: "approval_priority",
  stored: "approvals.priority",
  states: APPROVAL_PRIORITIES,
  initial: ["normal"],
  terminal: [],
  transitions: {
    set_low: { from: ["normal", "high", "urgent"], to: "low", by: ["admin"], summary: "Lower the pending item's priority to low." },
    set_normal: { from: ["low", "high", "urgent"], to: "normal", by: ["admin"], summary: "Set the pending item's priority to normal." },
    set_high: { from: ["low", "normal", "urgent"], to: "high", by: ["admin"], summary: "Set the pending item's priority to high." },
    set_urgent: { from: ["low", "normal", "high"], to: "urgent", by: ["admin"], summary: "Raise the pending item's priority to urgent." },
  },
});

/** Route permissions remain authoritative; `by` in a machine is descriptive only. */
export function approvalPriorityLifecycle(priority: ApprovalPriority, status: string, isAdmin: boolean) {
  const reason = !isAdmin ? "Only an administrator may change priority." : status !== "pending" ? "Only pending approvals may change priority." : null;
  return APPROVAL_PRIORITY_MACHINE.describe(priority, reason ? {
    set_low: reason, set_normal: reason, set_high: reason, set_urgent: reason,
  } : undefined);
}
