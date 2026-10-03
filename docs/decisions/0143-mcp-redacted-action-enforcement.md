# ADR-0143: MCP Redacted Action Enforcement

Status: Accepted (MCP implementation; public mode remains gated)
Date: 2026-09-30

## Decision

Reserve migration 0120 and the MCP/evaluator surfaces for this chapter.
Persist the admitted tool input schema. A redacted action must validate against
that schema, bind consent to its original/effective digests, transformation
policy, and schema identity, and force action scope. Both original and effective
arguments must satisfy data-scope rules. Persist only the effective preview.

Connect before consuming consent. Redacted calls revalidate policy after the
connection and send the frozen effective snapshot. Policy epochs cover PII
configuration and tool schema changes. No database transaction spans a network
call. Admission is not cancellation: a later policy change cannot undo a tool
that has already begun running.

Redact decoded text/structured JSON results before returning or tracing them.
Opaque MCP image/audio/resource content is withheld, not declared scanned.
Unsafe transforms and missing/unsupported schemas fail closed. Completed calls
are metered even when their results must be withheld.

The public configuration schema and UI do not expose `redact` yet. Other
dispatch paths must refuse this internal mode until implemented. This chapter
does not complete model/connector redaction, streaming memory bounds, binary
inspection, or the full Credo parity programme.

## Implementation and Evidence

- Migration 0120 retains `mcp_tools.input_schema`. Existing nulls require a
  manifest sync. Discovery changes the policy generation; a first redacted
  call retries for a fresh evaluation after the schema is stored.
- Strict AJV 8.20.0 and ajv-formats 3.0.1 validate the effective action without
  coercion, defaults or property removal. These were already locked transitive
  packages and are now direct dependencies. Only self-contained draft-07
  schemas are accepted: references, IDs, async validators, unknown formats,
  unknown keywords and unsupported drafts refuse with a fixed error.
- The digest additionally binds schema identity. Action scope overrides a
  configured tool scope; raw-only legacy signatures cannot match. Both argument
  forms pass through the same kernel/data-scope rules. Refusals do not quote
  the rejected raw data-scope value. Pending deduplication includes context.
- The policy epoch covers PII sources, approval/ABAC versions, scope/grant
  changes, guardrail configuration, and actual tool schema/kind/halt changes.
  A no-op manifest upsert does not advance the tool epoch. The generation is
  read before server/tool/preparation inputs and again after connection. An
  approval consumer also asserts it inside its existing transaction. A policy
  change refuses without consuming consent; connections themselves are not
  tool execution. There is no transaction spanning network work.
- Only the prepared input is traceable. Failed preparation captures no input.
  Text and decoded structured output are transformed; opaque/extension content
  is withheld. A policy tightened while an already-redacted call runs can
  withhold its result; a relaxed policy does not undo redaction. Completed
  calls are metered. Upstream failures use fixed messages under this mode.

Verification: 39 new tests (18 pure, 21 real MCP/database integration), plus
258 adjacent tests: 297 passed across 12 files, with gateway typecheck, DB build
and pnpm 10.33.0 frozen/offline lockfile validation. The first broad run had
287 passing assertions but six unhandled Hono socket-close exceptions. Retry
and breaker MCP fixtures now use real HTTP sockets rather than Fastify's fake
injection sockets; the clean reruns include those tests. A proposed temporary
control-removal mutation was denied by the safety reviewer and NOT applied
or executed. Changed-payload, legacy-consent and concurrent-use negative
cases are permanent tests; no mutation-test success is claimed.

## Remaining Release Gates

Public configuration still rejects `redact`. The queue stores the effective
preview, but the current SPA approval page does not render `argumentsPreview`;
an approver-facing payload review and its browser tests are required before
enabling the feature. Model/connector final-byte
integration, transitions INTO redaction during calls begun in another mode,
complete output-policy generation checks, bounded/cancellable provider
collection, and a resource budget for adversarial schema compilation/regexes
remain open. No binary/encoded-content inspection is claimed. The schema is
the admitted stored manifest, not proof that an upstream has not changed
outside a sync. Policy admission is not in-flight cancellation, rate/budget
reservation, or a globally atomic snapshot of every ABAC/context signal.
Global epoch invalidation is deliberately conservative and may require a
retry when another governed policy record changes. Detector false negatives
and unchanged source-conversation retention remain separate limitations.
