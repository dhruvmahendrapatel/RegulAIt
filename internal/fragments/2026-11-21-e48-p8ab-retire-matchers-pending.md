<!-- fold: pending -->

**P8a and P8b — DONE (ADR-0239 "As built: P8a and P8b", 2026-11-21, lane E48).** The hand-written MCP and resource
approval-rule matchers are removed; with no engine the kernel refuses, and each Cedar evaluator keeps a transcription
of the old predicate as its oracle. What remains of P8: data scope (slice 3) still waits for a typed argument model.
Resource rate limits are still matched by the `resource.ts` predicate, and they move into the same Cedar request if a
third rule type joins.
