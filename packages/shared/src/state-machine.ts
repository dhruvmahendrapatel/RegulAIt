/**
 * ADR-0348: one declared transition table per lifecycle, read by the server, the UI and agents alike.
 *
 * A lifecycle column (`training_jobs.status`, `mcp_servers.admission_state`, ...) used to keep its rules in
 * scattered `if (row.status === "x")` checks and unguarded `UPDATE ... SET status`. A machine declared here is
 * the one place those rules live:
 *
 * - the SERVER asks `sourcesOf(event)` for the `WHERE status IN (...)` guard of its UPDATE, so a concurrent or
 *   out-of-order write matches no row and fails loudly instead of overwriting a newer state;
 * - an AGENT or MCP tool reads `describe(state)`: which state the record is in, every event, whether it is
 *   allowed now, and in plain words why not;
 * - the UI renders the same `describe` output from the API response, so a button is enabled exactly when the
 *   server would accept the transition, and a disabled one says why.
 *
 * Plain data and a few pure functions, with no dependency: the state lives in Postgres rows, not in an
 * in-memory actor, so a statechart runtime would add a bundle and a second model without removing the SQL guard
 * (the comparison is in ADR-0348).
 */

/** Who may cause a transition. Informational for readers (people and agents); permissions are still checked
 * by the route that performs it. */
export type TransitionActor = "user" | "admin" | "approver" | "worker" | "agent" | "system";

export interface TransitionDef<S extends string> {
  /** the states this event may leave from */
  readonly from: readonly S[];
  /** the one state it always lands in */
  readonly to: S;
  readonly by: readonly TransitionActor[];
  /** one plain sentence: what the transition means */
  readonly summary: string;
}

export interface MachineDef<S extends string, E extends string> {
  /** stable id, e.g. `training_job` */
  readonly id: string;
  /** where the state is stored, e.g. `training_jobs.status` */
  readonly stored: string;
  readonly states: readonly S[];
  /** the states a record may be created in */
  readonly initial: readonly S[];
  /** the states no event leaves. Declared rather than derived, and checked against the table, so a reader
   * sees the terminal set without working it out */
  readonly terminal: readonly S[];
  readonly transitions: { readonly [K in E]: TransitionDef<S> };
}

/** One event as `describe` reports it. */
export interface TransitionView<S extends string, E extends string> {
  readonly event: E;
  readonly to: S;
  readonly allowed: boolean;
  /** set when `allowed` is false: why, in words a person or an agent can act on */
  readonly reason?: string;
  readonly by: readonly TransitionActor[];
  readonly summary: string;
}

/** The machine-readable answer to "what state is X in, and what can I do next?". */
export interface StateDescription<S extends string, E extends string> {
  readonly machine: string;
  readonly state: S;
  readonly terminal: boolean;
  readonly transitions: ReadonlyArray<TransitionView<S, E>>;
}

/** A transition the table does not allow from the given state (a programming error or a stale client). */
export class IllegalTransitionError extends Error {
  readonly code = "illegal_transition";
  constructor(
    readonly machine: string,
    readonly event: string,
    readonly from: string,
    readonly allowedFrom: readonly string[],
  ) {
    super(
      `${machine}: '${event}' is not allowed from '${from}'` +
        (allowedFrom.length ? ` (only from ${allowedFrom.map((s) => `'${s}'`).join(", ")})` : ""),
    );
    this.name = "IllegalTransitionError";
  }
}

export interface StateMachine<S extends string, E extends string> {
  readonly def: MachineDef<S, E>;
  readonly events: readonly E[];
  isState(value: unknown): value is S;
  isTerminal(state: S): boolean;
  /** may `event` be taken from `from`? */
  can(from: S, event: E): boolean;
  /** is there any declared event that moves `from` to `to`? For lifecycles whose next state is computed
   * (a scan verdict) rather than named by an event */
  canMove(from: S, to: S): boolean;
  /** the states `event` may leave from: the `WHERE status IN (...)` guard of its UPDATE */
  sourcesOf(event: E): readonly S[];
  /** the target of `event` from `from`, or throws IllegalTransitionError */
  next(from: S, event: E): S;
  /** every event with whether it is allowed from `state` and why not. `blocked` adds refusals that the table
   * alone cannot know (a permission, a precondition), keyed by event */
  describe(state: S, blocked?: Partial<Record<E, string>>): StateDescription<S, E>;
  /** the declaration as plain JSON, for an agent or a document */
  toJSON(): MachineDef<S, E>;
}

/**
 * Declare a machine. The declaration is checked when the module loads: every `from`, `to`, initial and
 * terminal state must be a declared state, a terminal state may have no outgoing event, and every state must be
 * reachable from an initial one. A malformed table fails at import, never at the first unlucky request.
 */
export function defineMachine<const S extends string, const E extends string>(
  def: MachineDef<S, E>,
): StateMachine<S, E> {
  const states = new Set<string>(def.states);
  const events = Object.keys(def.transitions) as E[];
  const fail = (msg: string): never => {
    throw new Error(`state machine '${def.id}': ${msg}`);
  };
  if (states.size !== def.states.length) fail("duplicate state");
  if (def.initial.length === 0) fail("no initial state");
  for (const s of [...def.initial, ...def.terminal]) if (!states.has(s)) fail(`unknown state '${s}'`);
  for (const e of events) {
    const t = def.transitions[e];
    if (t.from.length === 0) fail(`event '${e}' has no source state`);
    for (const s of [...t.from, t.to]) if (!states.has(s)) fail(`event '${e}' names unknown state '${s}'`);
    for (const s of t.from) if (def.terminal.includes(s)) fail(`terminal state '${s}' has outgoing event '${e}'`);
  }
  for (const s of def.states) {
    const leaves = events.some((e) => def.transitions[e].from.includes(s));
    if (!leaves && !def.terminal.includes(s)) fail(`state '${s}' has no outgoing event but is not declared terminal`);
  }
  const reached = new Set<string>(def.initial);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of events) {
      const t = def.transitions[e];
      if (!reached.has(t.to) && t.from.some((s) => reached.has(s))) {
        reached.add(t.to);
        grew = true;
      }
    }
  }
  for (const s of def.states) if (!reached.has(s)) fail(`state '${s}' is unreachable`);

  const can = (from: S, event: E): boolean => def.transitions[event]?.from.includes(from) ?? false;
  const machine: StateMachine<S, E> = {
    def,
    events,
    isState: (value): value is S => typeof value === "string" && states.has(value),
    isTerminal: (state) => def.terminal.includes(state),
    can,
    canMove: (from, to) => events.some((e) => def.transitions[e].to === to && def.transitions[e].from.includes(from)),
    sourcesOf: (event) => def.transitions[event].from,
    next(from, event) {
      if (!can(from, event)) throw new IllegalTransitionError(def.id, event, from, def.transitions[event]?.from ?? []);
      return def.transitions[event].to;
    },
    describe(state, blocked = {}) {
      return {
        machine: def.id,
        state,
        terminal: def.terminal.includes(state),
        transitions: events.map((event) => {
          const t = def.transitions[event];
          const base = { event, to: t.to, by: t.by, summary: t.summary };
          if (!t.from.includes(state)) {
            return {
              ...base,
              allowed: false,
              reason: def.terminal.includes(state)
                ? `'${state}' is final; nothing leaves it`
                : `'${event}' is allowed only from ${t.from.map((s) => `'${s}'`).join(", ")}, and this is '${state}'`,
            };
          }
          const refusal = blocked[event];
          return refusal ? { ...base, allowed: false, reason: refusal } : { ...base, allowed: true };
        }),
      };
    },
    toJSON: () => def,
  };
  return Object.freeze(machine);
}
