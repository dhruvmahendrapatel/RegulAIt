# ADR-0160: Continuous Trace Evaluation with the Shipped Detectors

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0042 (guardrails), ADR-0070/0111 (traces, previews), ADR-0099/0102
(credential scrub), ADR-0157 (monitor), ADR-0064 (scheduler); ROADMAP §9 Phase 3
"Trace ingestion and continuous evaluation"
Migration: 0126 (`trace_evaluations`)

## Context

Inline guardrails decide per call, and a detector set to `log` or `warn`
lets content through by design. Nothing answered "what did our agents
actually return this week that a detector would flag?" — the question a
Monitor & Respond posture starts from.

## Decision

1. **A scheduled sweep** (`trace-evaluation-sweep`, 15 min; also
   `POST /v1/governance/trace-evaluations/run`) evaluates completed model-call
   spans (`llm`, `fallback_hop`, status `ok`) not yet evaluated, up to 500 per
   pass, cursor = newest evaluated `span_started_at` minus a 10-minute
   overlap; the unique span id makes the overlap idempotent.
2. **The shipped heuristic detectors, nothing new**: OUTPUT — pii,
   semantic_dlp, toxicity (a hit is a leak and flags the span); INPUT —
   prompt_injection, jailbreak (a hit is an attempt, counted, never held
   against the agent). No model call, no cost.
3. **The write-time credential scrub is evidence, not an obstacle**: trace
   previews hold `[redacted:<kind>:<len>:<hash>]` instead of the secret, so
   the marker in an OUTPUT counts as `credential_material_scrubbed`.
4. **Counts only.** `trace_evaluations.findings` is `{phase, detector,
   category, count}`; no matched text is stored (tested).
5. **Honest coverage**: withheld content (a block fired) and uncaptured
   content (capture off) are recorded as `withheld` / `no_content` and
   reported as coverage, never as clean.
6. **Feeds the monitor**: rule `agent_output_leakage` (high) for an agent of
   an approved use case with ≥1 flagged response in 7 days; its remediation is
   guidance (`tighten_output_guardrail`) — a guardrail policy change is a
   person's decision. `GET /v1/governance/trace-evaluations?days=` gives the
   per-agent summary. Admin-only.

## Consequences

- Previews are truncated to the capture limit; a hit past it is not seen
  (stated in the response notes).
- A span that stays `running` longer than the overlap and finishes behind the
  cursor is not evaluated; model calls are well inside 10 minutes, and the
  limitation is written here rather than hidden.
- A model-tier detector, when wired, slots into the same sweep.

## Tests

`packages/shared/src/trace-evaluation.test.ts` (6),
`governance-monitor.test.ts` (leakage rule), and
`apps/gateway/src/zz-adr0160-trace-evaluation.test.ts` (4).
