/**
 * ADR-0359 — a behaviour finding's lifecycle is the declared `BEHAVIOUR_FINDING_MACHINE` (`@regulait/shared`
 * state-machines, ADR-0348; owner rule 12). This module only maps the status an admin asks for onto the machine's
 * event, so the route's guarded UPDATE (`whereFrom`) and its `lifecycle` view both come from that one table.
 *
 *   open → acknowledged | dismissed;  acknowledged → dismissed;  dismissed is terminal
 */
import { BEHAVIOUR_FINDING_MACHINE, type BehaviourFindingStatus } from "@regulait/shared";

/** the status an admin may request -> the machine event that lands there */
export const FINDING_STATUS_EVENT = Object.freeze({ acknowledged: "acknowledge", dismissed: "dismiss" } as const);
export type SettableFindingStatus = keyof typeof FINDING_STATUS_EVENT;
export const SETTABLE_FINDING_STATUSES = Object.keys(FINDING_STATUS_EVENT) as [SettableFindingStatus, ...SettableFindingStatus[]];

/** the read-only lifecycle view returned with a finding (what may happen next, and why not) */
export const findingLifecycle = (status: BehaviourFindingStatus) => ({ status: BEHAVIOUR_FINDING_MACHINE.describe(status) });

export { BEHAVIOUR_FINDING_MACHINE };
