/**
 * ADR-0359 — the declared lifecycle of a behaviour finding (owner rule 12). Every writer asks this table; the status
 * route's guarded UPDATE takes its allowed source states from it.
 *
 *   open → acknowledged | dismissed;  acknowledged → dismissed;  dismissed is terminal
 */
import { BEHAVIOUR_FINDING_STATUSES, type BehaviourFindingStatus } from "@regulait/shared";

export const FINDING_STATUS_TRANSITIONS: Readonly<Record<BehaviourFindingStatus, readonly BehaviourFindingStatus[]>> = Object.freeze({
  open: ["acknowledged", "dismissed"],
  acknowledged: ["dismissed"],
  dismissed: [],
});

/** the states a finding may be in for a move to `to` (the guarded UPDATE's WHERE set) */
export function findingStatusSources(to: BehaviourFindingStatus): BehaviourFindingStatus[] {
  return BEHAVIOUR_FINDING_STATUSES.filter((from) => FINDING_STATUS_TRANSITIONS[from].includes(to));
}

/** the targets an admin may set: every state some state can move to */
export const SETTABLE_FINDING_STATUSES = BEHAVIOUR_FINDING_STATUSES.filter((s) => findingStatusSources(s).length > 0) as [
  BehaviourFindingStatus,
  ...BehaviourFindingStatus[],
];
