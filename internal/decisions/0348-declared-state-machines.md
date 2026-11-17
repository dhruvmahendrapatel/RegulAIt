# ADR-0348: Declared state machines: one typed transition table per lifecycle, guarded writes, and a read-only lifecycle view for people and agents

- **Status**: Accepted (lane E29 brief, 2026-11-17: the confirmed direction)
- **Date**: 2026-11-17
- **Index**: **Declared state machines (all pillars):** one typed transition table per lifecycle column in `@regulait/shared` (`defineMachine`), every lifecycle UPDATE guarded on its source states (`whereFrom`), and a read-only `lifecycle` view (state, every next step, allowed or not and why) on API responses for the UI and agents. No dependency, no migration.
- **Backlog item**: lane E29 (owner request 2026-11-17: "Find all of the implicit state machines in my app")
- **Built in**: lane E29, three PRs (1: this ADR, the inventory, the helper, training jobs and MCP admission; 2: incidents, eval runs, scheduler lease release, orchestration budget gate; 3: the remaining machines with F×S ≥ 5 and `GET /v1/state-machines`)
- **Migration**: none
- **Related**: [ADR-0065](0065-regulait-llm.md) (training jobs), [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) and
  [ADR-0100](0100-scheduled-mcp-admission-rescan.md) (MCP admission), [ADR-0176](0176-open-source-first.md),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md), ADR-0200 (engineering guidelines),
  [ADR-0254](0254-workflow-durable-execution-spike.md) (the workflow runner stays the engine)

## Context

The owner asked for every implicit state machine in the app: a status, state or phase column whose allowed
transitions live in scattered `if (row.status === "x")` checks, string compares and `UPDATE ... SET status = ...`
statements instead of one declared table. The full inventory, with file and line for every machine, its states, its
writers, who triggers them, and a triage score, is [internal/product/STATE_MACHINES.md](../product/STATE_MACHINES.md).
What it found, in short:

- **About 95 lifecycle columns.** Most have a CHECK constraint on their values, but none declares its transitions.
  The approvals queue has no CHECK at all.
- **Two machines are already explicit and stay as they are:** the workflow kernel (`packages/workflow-kernel`,
  a typed reducer over about 17 events) and the orchestration kernel (`transitionRun`, `expectStatus`). Both are
  persisted under `SELECT ... FOR UPDATE`. Engine runs, discovery runs and execution offers are lease-fenced and
  locked. These are the patterns the rest should follow.
- **The bugs are in the smaller machines.** A check-then-write (read the row, compare in JavaScript, then
  `UPDATE ... WHERE id = $1`) lets a concurrent or late writer overwrite a newer state. Examples: a training job
  cancelled between its approval and its post-commit start still runs and bills; a manifest scan that read `held`
  just before an admin cleared the server writes `held` back and wipes the clearance; an incident containment can
  reopen an incident someone just closed.
- **No API response says what may happen next.** The UI re-derives the server's transition rules from status strings
  in 30 to 40 components (`RisksPage` computes `open → mitigating` itself), and an agent has no way to ask "which
  transitions can I take, and why not" except by trying them.

## Decision

1. **One declared table per lifecycle, in `@regulait/shared` (`state-machine.ts`, `state-machines.ts`).**
   `defineMachine({ id, stored, states, initial, terminal, transitions })`, where each transition is
   `{ from: [...], to, by: [...actors], summary }`. The declaration is checked when the module loads: unknown states,
   an outgoing event from a terminal state, a dead end that is not declared terminal, or an unreachable state all
   throw at import. A machine answers `can`, `canMove`, `sourcesOf`, `next` (throws `IllegalTransitionError`),
   `describe` and `toJSON`. Every machine is registered by id in `STATE_MACHINES`.
2. **Every lifecycle write is guarded on its source states.** `whereFrom(column, machine, event)`
   (`apps/gateway/src/state-transition.ts`) is the `WHERE status IN (...)` of the UPDATE, used with `.returning()`.
   An empty result means another writer moved the row first; the caller reports the state that stands and writes,
   meters and audits nothing. Where the next state is computed from what the row says (a scan verdict), the
   read-to-write runs under `SELECT ... FOR NO KEY UPDATE`, as the existing engine-scan writer and the kernels do.
   Valid transitions behave exactly as before; evidence and audit rows are never rewritten.
3. **The database agrees with the table.** A gateway test reads each machine's CHECK constraint from `pg_constraint`
   and requires the same values. Where a column has no CHECK (approvals, the infra tables), adding one is a
   follow-up batch with an expand-contract migration, not part of this ADR.
4. **A read-only `lifecycle` view on the API.** `machine.describe(state, blocked)` returns
   `{ machine, state, terminal, transitions: [{ event, to, allowed, reason?, by, summary }] }`. `blocked` carries the
   refusals the table cannot know (a reserved tool name, a permission). The view is added to the record's existing
   GET response (`GET /v1/llm/jobs/:id`, each server in `GET /v1/mcp/admission` in slice 1) and, in slice 3, every
   declared machine is listed by `GET /v1/state-machines` for agents and MCP tools. It is a projection of the table,
   never a second rule set.
5. **The UI reads the same machine through the API, with no client library.** `apps/web` does not depend on
   `@regulait/shared` and keeps no copy of any transition rule. A screen enables a button when its event is
   `allowed` and shows `reason` when it is not. Screens are built by the design builders (#453); this lane exposes
   the data. UI-only machines (loading, error, empty, success flags, wizards) stay on TanStack Query and the kit's
   `Skeleton`, `EmptyState` and `ErrorState`; the inventory lists the contradictory-flag screens for the design lane.
6. **Triage follows the owner's rule.** Each problem is scored 1–10 for how often it happens (F) and how bad it is
   (S). F×S below 5 is filed as a GitHub issue labelled `triage-low` and the code is left alone. A machine in a file
   another lane's open PR is changing is recorded as a follow-up in the inventory, not converted here.

## Options compared (ADR-0176)

Searched the repo first: no transition table or helper exists (`TRANSITIONS`, `allowedTransitions`, `canTransition`
return nothing; the one hit is a comment). The kernels' reducers are domain-specific and stay. Then open source:

| | Licence | Maintained | Size (min+gz) | Air-gapped | Serialises for agents | Fits a Postgres row lifecycle |
|---|---|---|---|---|---|---|
| **Plain typed table (chosen)** | ours | n/a | 0 (server only) | yes | yes, it is data | yes: `sourcesOf` is the SQL guard |
| XState v5 (5.33.4) | MIT | yes (Nov 2026) | 14.5 KB | yes | config yes, but guards and actions are functions; "why not" needs a live actor and `snapshot.can()` per event | no: built for in-memory actors and statecharts; we would still write the SQL guard |
| @xstate/store (4.3.0) | MIT | yes (Oct 2026) | 4.1 KB | yes | partly | no: an event-driven store with no notion of states or legal transitions |
| robot3 (1.4.0) | BSD-2-Clause | yes (Oct 2026) | 1.3 KB | yes | no: machines are built from function calls | no SQL guard; transitions are closures |
| javascript-state-machine (3.1.0) | MIT | **no** (last release July 2018) | 2.7 KB | yes | partly | fails "actively maintained" |

The narrow exception of ADR-0176 rule 4 applies: no library meets the hard requirement that one declaration both
compiles to the server's guarded UPDATE and serialises as plain data an agent can read, and the state is multi-replica
Postgres state rather than an in-memory actor. What we wrote is about 150 lines of pure functions with no dependency.
Re-check when a statechart library gains a data-first "describe from a stored state" API, or when a UI flow
genuinely needs hierarchical or parallel states (then XState v5 is the candidate, for that flow only).

## Consequences

- **UX:** a screen can show the real state, the next steps allowed and why one is disabled, from the response it
  already fetches. A double click, a stale tab or two people acting at once get a 409 with the state that stands,
  never a silent overwrite.
- **DX:** one place to read a lifecycle (`state-machines.ts`); a typo in a state or an event is a compile error; a
  malformed table fails at import; a new writer gets its guard from `whereFrom` instead of hand-writing one.
- **AX:** an agent asks one machine-readable source what state a record is in and which transitions it can take, with
  reasons, instead of probing the API.
- **Cost:** no new dependency, no migration, no change to any valid transition. Each converted machine adds a
  test that its states equal the database's CHECK and that the races it had are closed.

## As built

- **Slice 1 (this PR):** the helper and registry; `training_job` (start, succeed, fail, refuse and cancel guarded;
  the succeed transition and its artifact commit together, so a cancelled job never gains an artifact or a charge;
  the cancel route answers 409 when the job settled first) and `mcp_admission` (the manifest scan's read-to-write
  under the row lock, the admin clear's guard from the table). `lifecycle` on `GET /v1/llm/jobs/:id` and on each
  server of `GET /v1/mcp/admission`. Tests: `packages/shared/src/state-machine.test.ts`,
  `apps/gateway/src/adr0348-state-machines.test.ts` (the three race tests fail on the code before this change).
