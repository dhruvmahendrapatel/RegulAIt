# ADR-0143: MCP Redacted Action Enforcement

Status: Accepted (implementation in progress)
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
