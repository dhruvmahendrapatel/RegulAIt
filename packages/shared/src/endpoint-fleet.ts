/**
 * ADR-0360 §3 — the declared lifecycles of an endpoint agent update rollout and of its stages (owner rule 12,
 * ADR-0348, registered in `STATE_MACHINES`).
 *
 * The gateway guards every state write with `whereFrom(column, machine, event)`, so a stale or concurrent write
 * matches no row and is refused; the API returns `describe(state)`, so a person, the UI and an agent read the same
 * allowed next steps. Pure and zero-I/O.
 */
import { defineMachine } from "./state-machine.js";

/** `endpoint_update_rollouts.state` values (the column's CHECK lists the same, checked by the ADR-0348 test) */
export const ENDPOINT_ROLLOUT_STATES = ["draft", "running", "paused", "halted", "completed", "aborted"] as const;
export type EndpointRolloutState = (typeof ENDPOINT_ROLLOUT_STATES)[number];

/** `endpoint_update_rollout_stages.state` values */
export const ENDPOINT_ROLLOUT_STAGE_STATES = ["pending", "active", "done"] as const;
export type EndpointRolloutStageState = (typeof ENDPOINT_ROLLOUT_STAGE_STATES)[number];

export const ENDPOINT_ROLLOUT_MACHINE = defineMachine({
  id: "endpoint_update_rollout",
  stored: "endpoint_update_rollouts.state",
  states: ENDPOINT_ROLLOUT_STATES,
  initial: ["draft"],
  terminal: ["completed", "aborted"],
  transitions: {
    start: { from: ["draft"], to: "running", by: ["admin"], summary: "Start the rollout: the first stage's devices are offered the update (self-update must be on)." },
    advance: { from: ["running"], to: "running", by: ["admin"], summary: "Finish the active stage and offer the update to the next stage's devices." },
    complete: { from: ["running"], to: "completed", by: ["admin"], summary: "Finish the last stage: the rollout is done." },
    pause: { from: ["running"], to: "paused", by: ["admin"], summary: "Stop offering the update until the rollout is resumed." },
    resume: { from: ["paused", "halted"], to: "running", by: ["admin"], summary: "Offer the update again from the active stage (self-update must be on)." },
    halt: { from: ["running"], to: "halted", by: ["system"], summary: "A device reported a failed install or a rollback, so the update is no longer offered." },
    abort: { from: ["draft", "running", "paused", "halted"], to: "aborted", by: ["admin"], summary: "Cancel the rollout for good; devices already updated keep their version." },
  },
});
export type EndpointRolloutEvent = (typeof ENDPOINT_ROLLOUT_MACHINE.events)[number];

export const ENDPOINT_ROLLOUT_STAGE_MACHINE = defineMachine({
  id: "endpoint_update_rollout_stage",
  stored: "endpoint_update_rollout_stages.state",
  states: ENDPOINT_ROLLOUT_STAGE_STATES,
  initial: ["pending"],
  terminal: ["done"],
  transitions: {
    activate: { from: ["pending"], to: "active", by: ["admin"], summary: "This stage's devices are offered the update." },
    finish: { from: ["active"], to: "done", by: ["admin"], summary: "This stage is finished." },
  },
});

/**
 * ADR-0360 §6 — `edr_isolation_requests.state`, the lifecycle of an EDR isolation request.
 *
 *   requested ──approve──▶ submitting ──confirm──▶ isolated ──request_release──▶ release_requested ──approve_release──▶ releasing ──confirm_release──▶ released
 *        └──reject──▶ rejected     └──fail──▶ failed                    reject_release ◀──┘        fail_release ──▶ isolated
 *
 * Isolating narrows access, so it needs a second admin's approval with a fresh step-up; releasing widens it back, so it
 * needs the same plus a `settings_relax` step-up. `confirm`, `fail`, `confirm_release` and `fail_release` are the
 * system's, from the vendor's action status.
 */
export const EDR_ISOLATION_STATES = ["requested", "rejected", "submitting", "isolated", "failed", "release_requested", "releasing", "released"] as const;
export type EdrIsolationState = (typeof EDR_ISOLATION_STATES)[number];

export const EDR_ISOLATION_MACHINE = defineMachine({
  id: "edr_isolation_request",
  stored: "edr_isolation_requests.state",
  states: EDR_ISOLATION_STATES,
  initial: ["requested"],
  terminal: ["rejected", "failed", "released"],
  transitions: {
    approve: { from: ["requested"], to: "submitting", by: ["approver"], summary: "A second admin approves (with a fresh step-up) and the EDR is asked to isolate the device." },
    reject: { from: ["requested"], to: "rejected", by: ["approver"], summary: "A second admin rejects the request; nothing is sent to the EDR." },
    confirm: { from: ["submitting"], to: "isolated", by: ["system"], summary: "The EDR reports the device isolated." },
    fail: { from: ["submitting"], to: "failed", by: ["system"], summary: "The EDR refused or failed the isolation." },
    request_release: { from: ["isolated"], to: "release_requested", by: ["admin"], summary: "Ask to release the device from isolation (widens access back)." },
    approve_release: { from: ["release_requested"], to: "releasing", by: ["approver"], summary: "A second admin approves the release (settings_relax step-up) and the EDR is asked to release the device." },
    reject_release: { from: ["release_requested"], to: "isolated", by: ["approver"], summary: "A second admin rejects the release; the device stays isolated." },
    confirm_release: { from: ["releasing"], to: "released", by: ["system"], summary: "The EDR reports the device released." },
    fail_release: { from: ["releasing"], to: "isolated", by: ["system"], summary: "The EDR failed the release; the device stays isolated." },
  },
});
export type EdrIsolationEvent = (typeof EDR_ISOLATION_MACHINE.events)[number];

/** the states still open (not terminal): the one-open-request index covers exactly these */
export const EDR_ISOLATION_OPEN_STATES = EDR_ISOLATION_STATES.filter((st) => !EDR_ISOLATION_MACHINE.isTerminal(st));
