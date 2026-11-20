/**
 * ADR-0338: governed control of an agent inside its vendor platform (disable, quarantine and restore), the
 * vendor-neutral half: the action lifecycle, the kill-switch guard and the vocabulary a vendor adapter's `control`
 * member speaks (the member's interface is gateway-local). No vendor is named here; a vendor offers an action only once
 * its adapter declares one.
 */
import { defineMachine } from "./state-machine.js";

/** The two actions that take an agent out of service. `restore` is never a free choice: it reverses one of these. */
export const VENDOR_AGENT_CONTROL_ACTIONS = ["disable", "quarantine"] as const;
export type VendorAgentControlAction = (typeof VENDOR_AGENT_CONTROL_ACTIONS)[number];

/** What an admin asks for: one of the actions, or `restore` naming the earlier action it reverses. */
export const VENDOR_AGENT_REQUEST_ACTIONS = [...VENDOR_AGENT_CONTROL_ACTIONS, "restore"] as const;
export type VendorAgentRequestAction = (typeof VENDOR_AGENT_REQUEST_ACTIONS)[number];

/** `apply` takes the agent out of service (narrows); `reverse` puts it back (widens). */
export type ControlDirection = "apply" | "reverse";
export interface ControlOp {
  readonly action: VendorAgentControlAction;
  readonly direction: ControlDirection;
}

export const VENDOR_AGENT_STATES = ["active", "disabled", "quarantined", "unknown"] as const;
export type VendorAgentServiceState = (typeof VENDOR_AGENT_STATES)[number];
export interface VendorAgentState {
  readonly state: VendorAgentServiceState;
  readonly observedAt?: string;
}

export const CONTROL_OUTCOMES = ["applied", "already_in_state", "refused", "failed"] as const;
export type ControlOutcome = (typeof CONTROL_OUTCOMES)[number];
export interface ControlResult {
  readonly outcome: ControlOutcome;
  /** a fixed code, never vendor text */
  readonly code: string;
  readonly httpStatus?: number;
}

// The adapter contract itself (`VendorAgentControl`, its context and agent reference) is gateway-local
// (apps/gateway/src/vendor-agent-control-contract.ts), so the external-effects barrier classifies its writes.

/** the service state an action leaves the agent in, and the one its reverse leaves it in */
export function targetStateOf(op: ControlOp): VendorAgentServiceState {
  if (op.direction === "reverse") return "active";
  return op.action === "disable" ? "disabled" : "quarantined";
}

// ---------------------------------------------------------------------------
// The kill-switch guard (ADR-0338 section 7, owner decision 2: narrowing only)
// ---------------------------------------------------------------------------

/** the org execution dial (ADR-0124), as `org_settings.execution_mode` stores it */
export type KillSwitchDial = "normal" | "read_only" | "require_approval" | "halted";
/** narrowing takes access away; widening gives it back */
export type ActionEffect = "narrowing" | "widening";

export const effectOfDirection = (direction: ControlDirection): ActionEffect => (direction === "apply" ? "narrowing" : "widening");

/**
 * Generic and vendor-neutral, so any lifecycle that takes something out of service can reuse it: a narrowing action
 * passes under any dial, a widening one only under `normal`. Returns null when allowed, or the refusal in words a
 * person or an agent can act on (the same text `describe` reports).
 */
export function killSwitchNarrowingOnly(args: { readonly dial: KillSwitchDial; readonly effect: ActionEffect }): string | null {
  if (args.dial === "normal" || args.effect === "narrowing") return null;
  return `the execution mode is '${args.dial}': only actions that take something out of service run until it is back to normal`;
}

// ---------------------------------------------------------------------------
// The action lifecycle (ADR-0338 section 5), declared with ADR-0348's defineMachine
// ---------------------------------------------------------------------------

export const VENDOR_AGENT_ACTION_STATES = [
  "requested",
  "approved",
  "executing",
  "unknown",
  "succeeded",
  "already_in_state",
  "failed",
  "denied",
  "cancelled",
] as const;
export type VendorAgentActionState = (typeof VENDOR_AGENT_ACTION_STATES)[number];

/** `vendor_agent_actions.status`. A restore is a new row, so terminal rows stay terminal. */
export const VENDOR_ACTION_MACHINE = defineMachine({
  id: "vendor_agent_action",
  stored: "vendor_agent_actions.status",
  states: VENDOR_AGENT_ACTION_STATES,
  initial: ["requested"],
  terminal: ["succeeded", "already_in_state", "failed", "denied", "cancelled"],
  transitions: {
    approve: {
      from: ["requested"],
      to: "approved",
      by: ["approver"],
      summary: "A second administrator in the approval's pool approved it, with a step-up; the requester may execute it once.",
    },
    deny: {
      from: ["requested"],
      to: "denied",
      by: ["approver"],
      summary: "The approver refused it; nothing is sent to the vendor.",
    },
    cancel: {
      from: ["requested", "approved"],
      to: "cancelled",
      by: ["user", "admin"],
      summary: "The requester or an admin cancelled it before it ran; nothing is sent to the vendor.",
    },
    expire: {
      from: ["requested", "approved"],
      to: "cancelled",
      by: ["system"],
      summary: "Its approval window passed before it was decided or executed; nothing is sent, and a new request is needed.",
    },
    execute: {
      from: ["approved"],
      to: "executing",
      by: ["user"],
      summary: "The requester executed it with a fresh step-up; the approval is consumed and the vendor is called once.",
    },
    succeed: {
      from: ["executing", "unknown"],
      to: "succeeded",
      by: ["system"],
      summary: "The vendor reports the agent in the target state.",
    },
    find_in_state: {
      from: ["executing", "unknown"],
      to: "already_in_state",
      by: ["system"],
      summary: "The agent was already in the target state; nothing changed at the vendor.",
    },
    fail: {
      from: ["executing", "unknown"],
      to: "failed",
      by: ["system"],
      summary: "The vendor refused or the call failed; the code says why. A new request is needed to try again.",
    },
    lose_track: {
      from: ["executing"],
      to: "unknown",
      by: ["system"],
      summary: "The call timed out, or the execution's lease expired after a crash; the outcome is settled by reading the state, never a second call.",
    },
  },
});
