/**
 * ADR-0349 (lane E30, idea 1 of 5 borrowed from Temporal): deterministic replay of a recorded event history.
 *
 * A workflow instance's stored state (`workflow_instances.state`) is the fold of its recorded events
 * (`workflow_events.event`, in commit order) through `transition()`, starting from `initialState()` of the
 * instance's snapshotted definition. That is the same property Temporal's replayer checks for workflow code: a
 * kernel change that would fold the same recorded history to a different state would silently change what an
 * IN-FLIGHT instance does next. `replayEvents` is the one fold; the replay-fixture suite runs it over recorded
 * histories in CI, and the process-analytics read model (lane E23, PR #888) can use it for its own replay.
 *
 * Pure and total: a history the kernel refuses is a result (`refused`, with the index of the event), never a throw,
 * so a caller can report every divergent history at once.
 */
import {
  initialState,
  transition,
  WorkflowStateError,
  type InstanceState,
  type InstanceStatus,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "./index.js";

export type ReplayOutcome =
  | {
      ok: true;
      state: InstanceState;
      /** the instance status after each event, in order (a divergence report names the first that differs) */
      statuses: InstanceStatus[];
    }
  | {
      ok: false;
      /** the index (0-based) of the event the kernel refused */
      index: number;
      event: WorkflowEvent;
      reason: string;
      statuses: InstanceStatus[];
    };

/** Fold `events` through `transition` from the definition's initial state. */
export function replayEvents(def: WorkflowDefinition, events: readonly WorkflowEvent[]): ReplayOutcome {
  let state = initialState(def);
  const statuses: InstanceStatus[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    try {
      state = transition(def, state, event).state;
    } catch (err) {
      // only the kernel's own refusal is a replay result; anything else is a bug and propagates
      if (!(err instanceof WorkflowStateError)) throw err;
      return { ok: false, index: i, event, reason: err.message, statuses };
    }
    statuses.push(state.status);
  }
  return { ok: true, state, statuses };
}

/** The first difference between two instance states, in words, or null when they are equal. */
export function stateDifference(expected: InstanceState, actual: InstanceState): string | null {
  if (expected.status !== actual.status) return `status: expected '${expected.status}', got '${actual.status}'`;
  if (expected.currentStageIndex !== actual.currentStageIndex) {
    return `currentStageIndex: expected ${expected.currentStageIndex}, got ${actual.currentStageIndex}`;
  }
  if (expected.stageStatuses.length !== actual.stageStatuses.length) {
    return `stageStatuses: expected ${expected.stageStatuses.length} stages, got ${actual.stageStatuses.length}`;
  }
  for (let i = 0; i < expected.stageStatuses.length; i++) {
    if (expected.stageStatuses[i] !== actual.stageStatuses[i]) {
      return `stageStatuses[${i}]: expected '${expected.stageStatuses[i]}', got '${actual.stageStatuses[i]}'`;
    }
  }
  const keys = new Set([...Object.keys(expected.artifactVersions), ...Object.keys(actual.artifactVersions)]);
  for (const k of [...keys].sort()) {
    if (expected.artifactVersions[k] !== actual.artifactVersions[k]) {
      return `artifactVersions['${k}']: expected ${expected.artifactVersions[k] ?? "none"}, got ${actual.artifactVersions[k] ?? "none"}`;
    }
  }
  return null;
}
