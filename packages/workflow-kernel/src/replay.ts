/**
 * ADR-0342 — the pure workflow-history replayer.
 *
 * Replays an instance's recorded events (`workflow_events`, in time order) through `transition` from `initialState`
 * against the instance's snapshotted definition, and checks that the replay ends at the state the engine stored.
 * It knows nothing about analytics, databases or transports: it takes events in and gives the replayed steps out, so
 * any consumer (process analytics, lane E30's CI replay check) reads the same ordering and divergence rules.
 *
 * Ordering. Events written in one transaction share a timestamp (`now()` is the transaction start), so their stored
 * order may not be the order they were applied. Events are taken in time order; within a group sharing one
 * timestamp the stored order is tried first, and the group is re-ordered only if the kernel refuses that order or the
 * replay does not end at the stored state. The search is bounded (`REPLAY_TIE_GROUP_MAX`, `REPLAY_SEARCH_BUDGET`).
 *
 * Outcomes:
 *   - `ok`: every event was accepted and the final state equals `stored` (status, current stage, stage statuses);
 *   - `diverged`: no accepted order reaches `stored` (or there are no events);
 *   - `too_long`: more than `REPLAY_EVENTS_MAX` events; nothing was replayed.
 */
import { initialState, transition, type InstanceState, type WorkflowDefinition, type WorkflowEvent } from "./index.js";

/** a history longer than this is not replayed */
export const REPLAY_EVENTS_MAX = 5000;
/** events sharing one timestamp are re-ordered at most this far */
export const REPLAY_TIE_GROUP_MAX = 8;
/** transitions tried across the whole search before giving up */
export const REPLAY_SEARCH_BUDGET = 10_000;

export interface ReplayEvent {
  event: WorkflowEvent;
  at: Date;
}

/** one applied event, with the state before and after it */
export interface ReplayStep {
  event: WorkflowEvent;
  at: Date;
  before: InstanceState;
  after: InstanceState;
}

export type ReplayResult =
  | { status: "ok"; steps: ReplayStep[]; final: InstanceState }
  | { status: "diverged"; reason: string }
  | { status: "too_long"; events: number };

/** the parts of a state a replay must reproduce */
export function sameInstanceState(a: InstanceState, b: InstanceState): boolean {
  return (
    a.status === b.status &&
    a.currentStageIndex === b.currentStageIndex &&
    JSON.stringify(a.stageStatuses) === JSON.stringify(b.stageStatuses)
  );
}

export function replayHistory(def: WorkflowDefinition, history: readonly ReplayEvent[], stored: InstanceState): ReplayResult {
  if (history.length > REPLAY_EVENTS_MAX) return { status: "too_long", events: history.length };
  if (history.length === 0) return { status: "diverged", reason: "no events" };

  const groups: ReplayEvent[][] = [];
  for (const h of history) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.at.getTime() === h.at.getTime()) last.push(h);
    else groups.push([h]);
  }

  let budget = REPLAY_SEARCH_BUDGET;
  const steps: ReplayStep[] = [];
  const walk = (gi: number, state: InstanceState, rest: ReplayEvent[]): boolean => {
    if (budget-- <= 0) return false;
    if (rest.length === 0) {
      if (gi === groups.length) return sameInstanceState(state, stored);
      const g = groups[gi]!;
      if (g.length > REPLAY_TIE_GROUP_MAX) return false;
      return walk(gi + 1, state, g);
    }
    for (let i = 0; i < rest.length; i++) {
      const h = rest[i]!;
      let after: InstanceState;
      try {
        after = transition(def, state, h.event).state;
      } catch {
        continue;
      }
      steps.push({ event: h.event, at: h.at, before: state, after });
      if (walk(gi, after, [...rest.slice(0, i), ...rest.slice(i + 1)])) return true;
      steps.pop();
      if (budget <= 0) return false;
    }
    return false;
  };

  if (!walk(0, initialState(def), [])) {
    return { status: "diverged", reason: "no accepted order of this history reproduces the stored state" };
  }
  return { status: "ok", steps, final: steps[steps.length - 1]!.after };
}
