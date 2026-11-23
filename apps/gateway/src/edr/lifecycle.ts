/**
 * ADR-0360 §6 — the EDR isolation request lifecycle. The table is declared once, in @regulait/shared
 * (`EDR_ISOLATION_MACHINE`, registered in `STATE_MACHINES`, ADR-0348); every writer guards its UPDATE with
 * `whereFrom` and the API returns `describe(state)`.
 */
import { EDR_ISOLATION_MACHINE, type EdrIsolationEvent, type EdrIsolationState } from "@regulait/shared";

export type IsolationState = EdrIsolationState;
export type IsolationEvent = EdrIsolationEvent;

export const ISOLATION_MACHINE = EDR_ISOLATION_MACHINE;

/** the states still open (not terminal): the one-open-request index covers exactly these */
export const ISOLATION_OPEN_STATES = ISOLATION_MACHINE.def.states.filter((s) => !ISOLATION_MACHINE.def.terminal.includes(s));
