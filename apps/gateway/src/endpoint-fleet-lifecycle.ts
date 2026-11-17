/**
 * ADR-0360 §3 — the declared lifecycles of an endpoint agent update rollout and of its stages (owner rule 12,
 * 2026-11-17). One table per field; every writer asks this module for the guard of its UPDATE (`sourcesOf`) instead of
 * carrying its own if/else, and the API returns `describe(state)` so a person, the UI and an agent see the same
 * allowed next steps.
 *
 * The tables are written in ADR-0348's `MachineDef` shape (states, initial, terminal, transitions with from, to, by and
 * summary). Lane E29's `defineMachine` (packages/shared/src/state-machine.ts, PR #920) is not on main yet; when it
 * lands these two declarations move onto it unchanged, and the few helpers below are deleted.
 */
import { ENDPOINT_ROLLOUT_STAGE_STATES, ENDPOINT_ROLLOUT_STATES } from "@regulait/db";

export type RolloutState = (typeof ENDPOINT_ROLLOUT_STATES)[number];
export type RolloutStageState = (typeof ENDPOINT_ROLLOUT_STAGE_STATES)[number];
export type Actor = "admin" | "approver" | "system";

export interface Transition<S extends string> {
  readonly from: readonly S[];
  readonly to: S;
  readonly by: readonly Actor[];
  readonly summary: string;
}
export interface Machine<S extends string, E extends string> {
  readonly id: string;
  readonly stored: string;
  readonly states: readonly S[];
  readonly initial: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: { readonly [K in E]: Transition<S> };
}

export type RolloutEvent = "start" | "advance" | "complete" | "pause" | "resume" | "halt" | "abort";

export const ROLLOUT_MACHINE: Machine<RolloutState, RolloutEvent> = {
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
};

export type StageEvent = "activate" | "finish";

export const ROLLOUT_STAGE_MACHINE: Machine<RolloutStageState, StageEvent> = {
  id: "endpoint_update_rollout_stage",
  stored: "endpoint_update_rollout_stages.state",
  states: ENDPOINT_ROLLOUT_STAGE_STATES,
  initial: ["pending"],
  terminal: ["done"],
  transitions: {
    activate: { from: ["pending"], to: "active", by: ["admin"], summary: "This stage's devices are offered the update." },
    finish: { from: ["active"], to: "done", by: ["admin"], summary: "This stage is finished." },
  },
};

/** the states `event` may leave from: the `WHERE state IN (...)` guard of its UPDATE */
export function sourcesOf<S extends string, E extends string>(m: Machine<S, E>, event: E): S[] {
  return [...m.transitions[event].from];
}

export function can<S extends string, E extends string>(m: Machine<S, E>, from: S, event: E): boolean {
  return m.transitions[event].from.includes(from);
}

/** every event with whether it is allowed now and, when not, why in plain words; `blocked` adds refusals the table cannot know */
export function describe<S extends string, E extends string>(m: Machine<S, E>, state: S, blocked: Partial<Record<E, string>> = {}) {
  const events = Object.keys(m.transitions) as E[];
  return {
    machine: m.id,
    state,
    terminal: m.terminal.includes(state),
    transitions: events.map((event) => {
      const t = m.transitions[event];
      const fromOk = t.from.includes(state);
      const reason = !fromOk ? `not allowed from '${state}' (only from ${t.from.map((s) => `'${s}'`).join(", ")})` : blocked[event];
      return { event, to: t.to, allowed: fromOk && !blocked[event], ...(reason ? { reason } : {}), by: t.by, summary: t.summary };
    }),
  };
}
