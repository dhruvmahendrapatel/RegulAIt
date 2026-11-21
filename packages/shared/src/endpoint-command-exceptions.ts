/**
 * ADR-0350 §5 — device groups and time-limited per-device exceptions to on-device command rules.
 *
 * The exception lifecycle is declared ONCE here (owner rule 12): the gateway refuses any transition this table does
 * not list, the UI shows the derived state, and an agent can read the table. `expired` is never written: it is
 * derived from `notAfter` against the database clock, so an approved exception lapses on time without a sweep, and
 * the device checks the same expiry on its own clock.
 *
 * Pure and zero-I/O.
 */
import { approvalArgumentsDigest } from "./approval-binding.js";
import { defineMachine, type StateDescription } from "./state-machine.js";

export const ENDPOINT_EXCEPTION_STATES = ["requested", "approved", "rejected", "cancelled", "revoked", "expired"] as const;
export type EndpointExceptionState = (typeof ENDPOINT_EXCEPTION_STATES)[number];

/** The states a row's `status` column may hold (`expired` is derived, never stored). */
export const ENDPOINT_EXCEPTION_STORED_STATES = ["requested", "approved", "rejected", "cancelled", "revoked"] as const;
export type EndpointExceptionStoredState = (typeof ENDPOINT_EXCEPTION_STORED_STATES)[number];

/**
 * `endpoint_command_exceptions.status` (ADR-0348, registered in `STATE_MACHINES`). Its states are the stored
 * ones; `expired` is a derived value excluded from the machine (ADR-0348 allows it): an approved row whose
 * `not_after` has passed reads as expired and refuses `revoke`, without a sweep writing anything.
 */
export const ENDPOINT_COMMAND_EXCEPTION_MACHINE = defineMachine({
  id: "endpoint_command_exception",
  stored: "endpoint_command_exceptions.status",
  states: ENDPOINT_EXCEPTION_STORED_STATES,
  initial: ["requested"],
  terminal: ["rejected", "cancelled", "revoked"],
  transitions: {
    approve: {
      from: ["requested"],
      to: "approved",
      by: ["approver"],
      summary: "The named approver, who is not the requester, approved the exact terms with a step-up; it lasts until not_after.",
    },
    reject: {
      from: ["requested"],
      to: "rejected",
      by: ["admin"],
      summary: "An admin other than the requester refused the request (refusing is the stricter outcome, so any admin may).",
    },
    cancel: {
      from: ["requested"],
      to: "cancelled",
      by: ["user"],
      summary: "The requester withdrew the request before a decision.",
    },
    revoke: {
      from: ["approved"],
      to: "revoked",
      by: ["admin"],
      summary: "An admin ended an approved exception before its expiry; the device stops applying it on its next policy.",
    },
  },
});
export type EndpointExceptionAction = (typeof ENDPOINT_COMMAND_EXCEPTION_MACHINE.events)[number];

/** Exceptions last at most this long without a separate relaxation (owner question open; secure default). */
export const ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS = 24;
/** No exception lasts longer; the device refuses one that does (ADR-0350 §3, `MaxExceptionLife`). */
export const ENDPOINT_EXCEPTION_HARD_MAX_HOURS = 168;

/** The verdicts an exception may relax a rule to. Deny is never a relaxation. */
export const ENDPOINT_EXCEPTION_VERDICTS = ["allow", "ask"] as const;

/** A rule id as the device policy names it (ADR-0350 §2): the device's `ruleIDShape`. */
export const ENDPOINT_RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The state a row is in now. */
export function endpointExceptionState(row: { status: EndpointExceptionStoredState; notAfter: Date | null }, now: Date): EndpointExceptionState {
  if (row.status === "approved" && row.notAfter !== null && now.getTime() >= row.notAfter.getTime()) return "expired";
  return row.status;
}

/** Why `action` cannot be applied to a row in `state`, or null when it can. */
export function endpointExceptionTransitionRefusal(state: EndpointExceptionState, action: EndpointExceptionAction): string | null {
  const to = ENDPOINT_COMMAND_EXCEPTION_MACHINE.def.transitions[action].to;
  if (state !== "expired" && ENDPOINT_COMMAND_EXCEPTION_MACHINE.can(state, action)) return null;
  return `an exception that is ${state} cannot be moved to ${to}`;
}

/** The machine-readable lifecycle of a row now: its stored state, every event and why one is refused. */
export function endpointExceptionLifecycle(
  row: { status: EndpointExceptionStoredState; notAfter: Date | null },
  now: Date,
): StateDescription<EndpointExceptionStoredState, EndpointExceptionAction> {
  const expired = endpointExceptionState(row, now) === "expired";
  return ENDPOINT_COMMAND_EXCEPTION_MACHINE.describe(row.status, expired ? { revoke: "the exception has already expired" } : {});
}

/** What an approver approves: exactly these facts, digested with the approvals queue's binding (ADR-0104). */
export interface EndpointExceptionTerms {
  deviceId: string;
  ruleId: string;
  verdict: (typeof ENDPOINT_EXCEPTION_VERDICTS)[number];
  hours: number;
  reason: string;
}

export function endpointExceptionDigest(t: EndpointExceptionTerms): string {
  return approvalArgumentsDigest({
    projectId: null,
    arguments: { kind: "endpoint_command_exception", deviceId: t.deviceId, ruleId: t.ruleId, verdict: t.verdict, hours: t.hours, reason: t.reason },
  });
}

/** Device-group rules may only narrow a user's policy: ask or deny, never allow (ADR-0350 §5). */
export const ENDPOINT_GROUP_RULE_KINDS = ["exec", "file", "package"] as const;
export const ENDPOINT_GROUP_RULE_VERDICTS = ["ask", "deny"] as const;
