# ADR-0132 - Atomic emergency state and audit

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-019
- Supersedes: ADR-0124's implicit state/audit atomicity claim

## Decision

Deployment mode, agent halt and tool halt transitions each lock their subject
row with `FOR UPDATE` and write the state change and audit fact in one database
transaction. Idempotency is checked after the lock, against the committed
state. Concurrent callers therefore cannot both report a real transition from
the same prior state, and an audit-insert failure rolls back the control change.
The mode row is initialized before taking its singleton lock. A transaction
that loses its connection before commit makes neither fact durable; retrying
reads the committed state and applies at most the remaining transition.

The transaction does not cancel already-running external work. ADR-0124's
coverage boundary still requires separate examination of effectful paths that
do not enter the AI policy kernel (AER-018).

## Verification

Failure injection at audit insert must leave each of the six set/lift states
unchanged, with the result still visible after rebuilding the application.
Twenty simultaneous changes to the same mode, agent or tool must yield one
`changed=true` and one transition audit. Conflicting mode changes must have
an ordered `from -> to` audit history matching final durable state.
