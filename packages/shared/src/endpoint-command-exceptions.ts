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

export const ENDPOINT_EXCEPTION_STATES = ["requested", "approved", "rejected", "cancelled", "revoked", "expired"] as const;
export type EndpointExceptionState = (typeof ENDPOINT_EXCEPTION_STATES)[number];

/** The states a row's `status` column may hold (`expired` is derived, never stored). */
export const ENDPOINT_EXCEPTION_STORED_STATES = ["requested", "approved", "rejected", "cancelled", "revoked"] as const;
export type EndpointExceptionStoredState = (typeof ENDPOINT_EXCEPTION_STORED_STATES)[number];

/** Allowed transitions, by the action that makes them. Terminal states have none. */
export const ENDPOINT_EXCEPTION_TRANSITIONS = {
  approve: { from: "requested", to: "approved" },
  reject: { from: "requested", to: "rejected" },
  cancel: { from: "requested", to: "cancelled" },
  revoke: { from: "approved", to: "revoked" },
} as const satisfies Record<string, { from: EndpointExceptionState; to: EndpointExceptionStoredState }>;
export type EndpointExceptionAction = keyof typeof ENDPOINT_EXCEPTION_TRANSITIONS;

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
  const t = ENDPOINT_EXCEPTION_TRANSITIONS[action];
  return t.from === state ? null : `an exception that is ${state} cannot be moved to ${t.to}`;
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
