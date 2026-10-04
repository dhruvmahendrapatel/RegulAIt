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
   pass, ~~cursor = newest evaluated `span_started_at` minus a 10-minute
   overlap; the unique span id makes the overlap idempotent.~~ **Replaced
   2026-10-03 by a durable anti-join queue above a fixed floor — see the
   AER-045 amendment at the end of this file.**
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
- ~~A span that stays `running` longer than the overlap and finishes behind the
  cursor is not evaluated; model calls are well inside 10 minutes, and the
  limitation is written here rather than hidden.~~ **Struck 2026-10-03: the
  limitation was real and wider than stated, and it is now removed — see the
  AER-045 amendment.**
- A model-tier detector, when wired, slots into the same sweep.

## Tests

`packages/shared/src/trace-evaluation.test.ts` (6),
`governance-monitor.test.ts` (leakage rule), and
`apps/gateway/src/zz-adr0160-trace-evaluation.test.ts` (4 at acceptance; 7 since the AER-045
amendment).

## Amendment 2026-10-03 — a durable anti-join queue replaces the `started_at` cursor (AER-045)

**What was wrong.** The sweep paged on `started_at >= max(evaluated span_started_at) - 10 min`.
A model call that completed (or whose row committed) after a newer span had been evaluated, and
that started more than ten minutes before that newer span, fell behind the cursor and was
**never** evaluated. The Consequences line above called this a span "running longer than the
overlap"; it was wider than that, because no `trace_spans` timestamp is commit-ordered:
`ended_at` is supplied by the caller in `recordSpan`, `created_at` is `now()` and so records the
transaction start, and `seq` counts per trace. No existing column can carry a high-water cursor
safely. Codex reproduced it on a disposable database: an 11-minute-old completed span with a
credential in its output, inserted after a newer clean span, scanned/evaluated/flagged 0.

**The decision.** There is no cursor. The work queue is the anti-join itself — every eligible
span (`llm`/`fallback_hop`, status `ok`) with no `trace_evaluations` row — above a **fixed floor**
= `min(trace_evaluations.evaluated_at)` minus the 7-day first-run lookback (`d6571ff`).

- **The floor never advances.** It is anchored on the first evaluation ever written, so it only
  excludes pre-deployment history; a span that completes late stays in the queue until it is
  evaluated. Before any evaluation exists it is `now - 7 days`, the original first-run behaviour.
  Trace retention deletes traces and spans but not `trace_evaluations`, so the anchor stays put.
- **Exactly once.** The `trace_evaluations_span_uq` unique index with `ON CONFLICT DO NOTHING ...
  RETURNING` writes one row per span, and the sweep's `evaluated`/`flagged`/`withheld`/`noContent`
  counts come from `RETURNING` — only rows this pass actually wrote — so a scheduler pass and a
  manual run that overlap no longer both report the same span. `scanned` is still the number of
  spans selected. Batches are ordered `(started_at, id)`, so a batch split by the limit is
  deterministic. The `OVERLAP_MS` constant is gone. No schema change, no migration.

**Evidence.** `zz-adr0160-trace-evaluation.test.ts` 7/7. `e814d31`: a span started 11 minutes
before an already-evaluated newer span flips from `running` to `ok` afterwards, and a completed
span 3 hours old lands; the next sweep evaluates both once (scanned 2, evaluated 2, flagged 1)
and a further sweep scans 0 with the rows unchanged; two overlapping passes queued on the unique
index write one row and report it once. Both fail on the pre-fix source (2 of 6). `e458a3e` pins
the floor, which nothing did before (replacing the anchor with `now` left every test green): the
first evaluation row is moved back 30 days, then a completed span started 10 days ago is
evaluated exactly once and one started 40 days ago (below the floor) is not. It fails on a
sliding `now - 7d` window, on anchoring at `max(evaluated_at)`, on dropping the floor, and on the
pre-fix cursor.

**Cost, corrected.** The first implementation note said query cost was "about the same as
before". It is not. Both versions scan `trace_spans` (it has no `started_at` index), but the old
cursor cut the join input to the last few minutes of spans; now every 15-minute pass anti-joins
every retained eligible span against all of `trace_evaluations`, which is never pruned. That is a
cost regression proportional to retained history, not a correctness one.

**Follow-up (needs a migration, not done):** a partial index on `trace_spans (started_at) WHERE
kind IN ('llm','fallback_hop') AND status = 'ok'` for the sweep, and pruning `trace_evaluations`
alongside trace retention (keeping the anchor row, or recording the floor explicitly). Also
noted by review: because counts now come from `RETURNING`, a `demo-traffic` run that loses the
insert race to a scheduler pass reports `flagged 0` and prints its "nothing was flagged — check
the org's trace content capture setting" note (`demo-traffic-lib.ts`) even though the span was
flagged; the note should read the persisted evaluation instead.
