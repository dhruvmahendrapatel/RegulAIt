<!-- fold: pending -->

**P-01c — ABAC v5 follow-ups (ADR-0251 slice 4a, 2026-11-14, lane L1).** (1) Done 2026-11-21 (slice 4c) for model and
connector calls: an ABAC `require_approval` holds the call in the approvals queue, its consent bound to the policy
version. A2A still refuses (no A2A approval queue yet). (2) Done 2026-11-21 (slice 4b): the governed core receives the request's session facts and the delegation chain,
each actor evaluated as `Agent`; a missing fact reads as its strict value. `context.rateLimitUsagePct` is still not
supplied for these calls, and the write-time guard still refuses a v5 policy on a governed action that reads it. (3) Make v5 the default schema version once the policy editor has an action
picker (UI builder, #453).
