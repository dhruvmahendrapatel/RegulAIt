/**
 * ADR-0360 §6 — the EDR isolation lifecycle, declared once in `@regulait/shared` (`EDR_ISOLATION_MACHINE`, ADR-0348)
 * and re-exported here for the gateway. `ISOLATION_OPEN_STATES` are the states that hold a device's one open request
 * (the partial unique index); `failed` is not terminal but does not hold the slot.
 */
import { EDR_ISOLATION_MACHINE, EDR_ISOLATION_OPEN_STATES, type EdrIsolationEvent, type EdrIsolationState } from "@regulait/shared";

export type IsolationState = EdrIsolationState;
export type IsolationEvent = EdrIsolationEvent;
export const ISOLATION_MACHINE = EDR_ISOLATION_MACHINE;
export const ISOLATION_OPEN_STATES: readonly IsolationState[] = EDR_ISOLATION_OPEN_STATES;
