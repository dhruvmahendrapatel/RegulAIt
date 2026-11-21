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
