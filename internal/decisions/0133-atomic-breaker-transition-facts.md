# ADR-0133 - Atomic breaker transition facts

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-023
- Amends: ADR-0126

## Decision

The MCP circuit breaker's opened, probing and closed state changes commit in
the same database transaction as their hash-chained audit transition. The
half-open election remains a conditional update against the observed opening
timestamp, so only one contender wins. Failure counting serializes on the
server row; the first update crossing the threshold opens and audits, while
later failures see an already-open row and restart cooldown without inventing
another opening. Recovery locks and reads the current row, rather than using
a potentially stale caller snapshot to decide whether to file a close fact.

Fast-fail requests still do not each write an audit row. A failed audit insert
now aborts the associated state transition; the next caller may retry it.

## Verification

Inject an audit-insert failure independently at opened, probing and closed:
the stored breaker state and transition count remain unchanged. Twenty
concurrent failures cross the threshold once; twenty concurrent successes
close once. Existing breaker, retry and health-probe suites must remain green.
