/**
 * ADR-0348: the SQL half of a declared state machine.
 *
 * `whereFrom(column, machine, event)` is the guard every lifecycle UPDATE carries: the row moves only if it is
 * still in a state the event may leave from. Used with `.returning()`, an empty result means another writer
 * moved the row first, and the caller reports that instead of overwriting the newer state.
 */
import { inArray, type PgColumn, type SQL } from "@regulait/db";
import type { StateMachine } from "@regulait/shared";

export function whereFrom<S extends string, E extends string>(
  column: PgColumn,
  machine: StateMachine<S, E>,
  event: E,
): SQL {
  return inArray(column, [...machine.sourcesOf(event)]);
}
