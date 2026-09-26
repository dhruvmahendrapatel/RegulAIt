-- ADR-0067 — GROUNDEDNESS, FAITHFULNESS AND HALLUCINATION MEASUREMENT.
--
-- ADR-0044 built an eval harness that can tell you an agent got WORSE. It could
-- not tell you whether an answer was SUPPORTED BY ITS CONTEXT — the one
-- measurement a regulated buyer asks for by name, and the one every parity
-- target (Langfuse, Braintrust, Arize Phoenix, Ragas) ships.
--
-- Two things this migration adds, and one it deliberately does not.
--
-- 1. CONTEXT ON A CASE. Groundedness is undefined without the material an
--    answer was supposed to rest on, so `eval_cases` gains `context` (a JSON
--    ARRAY, one entry per retrieved chunk) and `context_in_prompt`.
--
--    WHY AN ARRAY AND NOT A BLOB. Chunk boundaries are load-bearing. A claim
--    whose evidence has to be stitched out of fragments of three different
--    documents is precisely the fabrication a groundedness metric exists to
--    catch, and a single concatenated blob scores that as fully supported. The
--    scorer matches each claim against the SINGLE best chunk for the same
--    reason.
--
--    WHY A FLAG RATHER THAN TWO COLUMNS. `context_in_prompt = true` (the
--    default) means the context is prepended to the dispatch input, so the
--    metric measures the model against material it actually saw. `false` holds
--    it back for scoring only, which asks whether a model's parametric answer
--    happens to be grounded in a reference corpus. Those are two different
--    questions and the flag records which one was asked; storing the context
--    twice would let them drift.
--
--    STORAGE POSTURE — THIS IS NOT A BYPASS. Context is authored content stored
--    beside `input` and `expected` under the same authoring authority, and when
--    it rides the prompt it passes through the SAME §8.4 PII classifier and
--    ADR-0042 guardrails every other dispatch input does. A blocked context is
--    a blocked dispatch and the case scores zero, exactly as ADR-0044 already
--    handles a blocked prompt.
--
-- 2. SIX NEW SCORER KINDS, admitted by the two CHECK constraints that enumerate
--    them. Four are locally computable with no model, no network and no key
--    (`claim_support`, `context_precision`, `context_recall`,
--    `answer_relevance`). Two are model-backed (`groundedness_judge`,
--    `answer_relevance_judge`) and REFUSE — a real 422, before any run row is
--    written — when no dispatchable judge agent is named. They never fall back
--    to the lexical estimate under the judged name. See ADR-0067 §4.
--
-- 3. WHAT IS NOT HERE: no new results table. Per-claim verdicts and the
--    unsupported claims a compliance reviewer reads land in the EXISTING
--    `eval_results.detail` jsonb, alongside every other scorer's evidence, and
--    the score lands in the existing `score` column under its existing 0..1
--    CHECK. A parallel table would have meant a second definition of "a scored
--    case" and a second place for the baseline comparison to read from.
--
-- Reversal: the two columns drop cleanly; the CHECK constraints revert by
-- re-adding the ADR-0044 list, which will fail if any row already uses a new
-- kind. That is the correct behaviour — silently deleting a measurement to make
-- a rollback succeed is worse than a loud failure.

ALTER TABLE "eval_cases"
  ADD COLUMN IF NOT EXISTS "context" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "eval_cases"
  ADD COLUMN IF NOT EXISTS "context_in_prompt" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

ALTER TABLE "eval_datasets" DROP CONSTRAINT IF EXISTS "eval_datasets_scorer_kind_check";
--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_scorer_kind_check" CHECK (
  "scorer_kind" IN (
    'exact','contains','regex','json_schema','numeric','rubric','llm_as_judge',
    'claim_support','context_precision','context_recall','answer_relevance',
    'groundedness_judge','answer_relevance_judge'
  )
);
--> statement-breakpoint

ALTER TABLE "eval_cases" DROP CONSTRAINT IF EXISTS "eval_cases_scorer_kind_check";
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_scorer_kind_check" CHECK (
  "scorer_kind" IS NULL OR "scorer_kind" IN (
    'exact','contains','regex','json_schema','numeric','rubric','llm_as_judge',
    'claim_support','context_precision','context_recall','answer_relevance',
    'groundedness_judge','answer_relevance_judge'
  )
);
