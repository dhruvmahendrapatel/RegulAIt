# ADR-0129 - MCP operation admission and single-attempt tool execution

- Status: Accepted
- Date: 2026-09-29
- Supersedes: ADR-0128's read-tool retry exception and ADR-0126's proxy admission placement
- Findings: AER-022, AER-038
- Migration: none

## Decision

Every `tools/call` receives exactly one attempt. An upstream `readOnlyHint` remains
an authorization classification; it does not authorize replay. After a response
is lost, the gateway cannot know whether the operation committed an external
effect. This applies equally to direct proxy requests and delegated workers.
Connect and manifest-read retries retain their existing bounded policy.

The product does not currently offer a tool-retry opt-in. Any future opt-in needs
an operator-approved idempotency contract, a stable identity across attempts,
upstream deduplication, and evidence reconciling attempts with external effects.
Changing a tool annotation alone must never enable replay.

Breaker admission precedes the first upstream connection for an operation:

- Proxy `tools/list` elects at the route boundary, then records the manifest
  operation's success or failure. Initialization alone cannot close the breaker.
- Proxy `tools/call` uses the same governed primitive as delegated execution.
  The route opens no preliminary connection and runs no second election.
- Protocol initialization is local to the proxy and opens no upstream connection.
- Delegated manifest discovery also uses breaker admission and records its
  operation outcome. A refused server contributes no model tool definitions.

When a call must discover its tool before execution, discovery success does not
erase failures of the subsequent call. A successful full call closes the breaker.
An unknown tool may record the successful discovery before returning unknown.
Policy and admission refusals are not upstream failures.

## Verification Contract

The existing deadline tests must prove cooldown recovery and one elected probe
from twelve concurrent manifest requests. Additional operation tests cover servers
that initialize successfully but fail list/call, and proxy/worker contention for
one half-open probe with a single recovery audit transition.

The retry regression writes an external-effect record before returning a 503.
Both read-hinted and write tools must leave one record and one upstream execution.
The configured retry count must not change this outcome.

Exact commands and results belong in the session log and `codexInputs.md`.
This decision does not establish production readiness or resolve the separately
tracked atomicity of breaker state and audit transitions (AER-023).
