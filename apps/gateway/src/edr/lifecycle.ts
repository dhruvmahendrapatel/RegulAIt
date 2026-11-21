/**
 * ADR-0360 §6 — the EDR isolation lifecycle is the ADR-0348 machine `EDR_ISOLATION_MACHINE` in @regulait/shared
 * (registered in STATE_MACHINES). This module only names it for the EDR routes and service.
 */
export {
  EDR_ISOLATION_MACHINE as ISOLATION_MACHINE,
  EDR_ISOLATION_OPEN_STATES as ISOLATION_OPEN_STATES,
  type EdrIsolationEvent as IsolationEvent,
  type EdrIsolationState as IsolationState,
} from "@regulait/shared";
