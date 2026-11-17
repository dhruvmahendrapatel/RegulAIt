/**
 * ADR-0333 — the declared lifecycles of a detection incident (owner rule 12, 2026-11-17). One table per field; every
 * writer asks this module instead of carrying its own if/else or SQL guard.
 *
 *   status:          open → acknowledged | closed;  acknowledged → acknowledged | closed;  closed is terminal
 *   response_state:  none → done | failed;  done and failed are terminal (a response runs at most once)
 */
import { DETECTION_INCIDENT_STATUSES, DETECTION_RESPONSE_STATES } from "@regulait/db";

export type DetectionIncidentStatus = (typeof DETECTION_INCIDENT_STATUSES)[number];
export type DetectionResponseState = (typeof DETECTION_RESPONSE_STATES)[number];

/** re-acknowledging stays allowed (an idempotent admin click, as before rule 12) */
export const INCIDENT_STATUS_TRANSITIONS: Readonly<Record<DetectionIncidentStatus, readonly DetectionIncidentStatus[]>> =
  Object.freeze({
    open: ["acknowledged", "closed"],
    acknowledged: ["acknowledged", "closed"],
    closed: [],
  });

export const RESPONSE_STATE_TRANSITIONS: Readonly<Record<DetectionResponseState, readonly DetectionResponseState[]>> =
  Object.freeze({
    none: ["done", "failed"],
    done: [],
    failed: [],
  });

function sourcesOf<S extends string>(table: Readonly<Record<S, readonly S[]>>, to: S): S[] {
  return (Object.keys(table) as S[]).filter((from) => table[from].includes(to));
}

/** the states an incident may be in for a move to `to` (used as the guarded UPDATE's WHERE set) */
export function incidentStatusSources(to: DetectionIncidentStatus): DetectionIncidentStatus[] {
  return sourcesOf(INCIDENT_STATUS_TRANSITIONS, to);
}

export function responseStateSources(to: DetectionResponseState): DetectionResponseState[] {
  return sourcesOf(RESPONSE_STATE_TRANSITIONS, to);
}

/** the targets an admin may set through the API: every state some state can move to */
export const ADMIN_SETTABLE_STATUSES = DETECTION_INCIDENT_STATUSES.filter(
  (s) => incidentStatusSources(s).length > 0,
) as DetectionIncidentStatus[];

/** the response states a response may still run from (the runner's pending set) */
export const RESPONSE_PENDING_STATES = DETECTION_RESPONSE_STATES.filter(
  (s) => RESPONSE_STATE_TRANSITIONS[s].length > 0,
) as DetectionResponseState[];
