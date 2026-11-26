/**
 * ADR-0341 §9 (rule 12, on ADR-0348's `defineMachine`): the lifecycle of a sub-process (workflow fragment) version.
 *
 * The state is not a column of `workflow_fragment_versions`: it is the status of the version's own Approvals Queue row
 * (kind `workflow_fragment`), so one fact lives in one place and the one decide path is the only writer. This machine
 * is what that status means for the catalogue, and `fragmentVersionState` reads it, failing closed: any approval status
 * not named here (a future one, or a removed row) reads as rejected.
 */
import { defineMachine } from "./state-machine.js";

export const WORKFLOW_FRAGMENT_VERSION_MACHINE = defineMachine({
  id: "workflow_fragment_version",
  // the status of the version's own approval row (object_type workflow_fragment), mapped by fragmentVersionState
  stored: "approvals.status",
  states: ["pending_approval", "approved", "rejected"],
  initial: ["pending_approval"],
  terminal: ["approved", "rejected"],
  transitions: {
    approve: {
      from: ["pending_approval"],
      to: "approved",
      by: ["approver"],
      summary: "The named reviewer approved the version; it is listed and templates may pin it.",
    },
    reject: {
      from: ["pending_approval"],
      to: "rejected",
      by: ["approver"],
      summary: "The named reviewer rejected the version; it is never listed and no template may pin it.",
    },
  },
});

export type WorkflowFragmentVersionState = (typeof WORKFLOW_FRAGMENT_VERSION_MACHINE.def.states)[number];

/** the approval statuses that map to a state; every other status is rejected (fail closed) */
const STATE_OF_APPROVAL: Readonly<Record<string, WorkflowFragmentVersionState>> = {
  pending: "pending_approval",
  approved: "approved",
  denied: "rejected",
};

export function fragmentVersionState(approvalStatus: string | null | undefined): WorkflowFragmentVersionState {
  return (approvalStatus != null ? STATE_OF_APPROVAL[approvalStatus] : undefined) ?? "rejected";
}

/** the one state the catalogue lists and a template may pin */
export const FRAGMENT_VERSION_CALLABLE_STATE: WorkflowFragmentVersionState = "approved";
/** the approval status that state is read from (for a SQL filter) */
export const FRAGMENT_VERSION_CALLABLE_APPROVAL_STATUS = "approved";
