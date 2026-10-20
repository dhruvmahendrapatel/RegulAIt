/**
 * ADR-0190 slice I5 (review MEDIUM-2) — "this run's task is over", inside one runner process.
 *
 * The task bridge learns first that a run's sandbox task was refused or ended (the gateway's frames answer, or a
 * refused start). The gateway has then already ended a refused run (`not_run`, isolation_unavailable), but the
 * runner's run loop only hears it on its next heartbeat. The bridge signals here and the run loop beats AT ONCE: the
 * gateway's `cancel` (or its still-live answer) is the decision, never this signal. Nothing here is trusted beyond
 * "ask the gateway now".
 */
const listeners = new Map<string, Set<() => void>>();

/** the run loop: call `fn` when the bridge signals `runId` (returns the unsubscribe) */
export function onTaskOver(runId: string, fn: () => void): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(fn);
  return () => {
    const s = listeners.get(runId);
    s?.delete(fn);
    if (s && s.size === 0) listeners.delete(runId);
  };
}

/** the bridge: the task of `runId` is over here (refused, ended or failed) */
export function signalTaskOver(runId: string): void {
  for (const fn of [...(listeners.get(runId) ?? [])]) {
    try {
      fn();
    } catch {
      // a listener's failure never stops the bridge
    }
  }
}
