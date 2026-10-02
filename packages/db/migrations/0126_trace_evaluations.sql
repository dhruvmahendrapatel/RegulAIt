-- ADR-0160 — continuous trace evaluation results.
--
-- One row per evaluated model-call span. COUNTS ONLY: `findings` holds
-- {phase, detector, category, count} — never matched text. The span id is
-- unique, so a sweep that overlaps the previous one is idempotent, and the
-- newest `span_started_at` is the sweep's cursor. No FK to trace_spans on
-- purpose: trace retention may prune spans; the evaluation is its own record.
CREATE TABLE IF NOT EXISTS "trace_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "span_id" uuid NOT NULL,
  "trace_id" uuid NOT NULL,
  "agent_id" uuid,
  "span_started_at" timestamp with time zone NOT NULL,
  "outcome" text NOT NULL,
  "flagged" boolean DEFAULT false NOT NULL,
  "findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trace_evaluations_outcome_check" CHECK ("outcome" IN ('evaluated', 'withheld', 'no_content')),
  CONSTRAINT "trace_evaluations_flag_check" CHECK (NOT "flagged" OR "outcome" = 'evaluated')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trace_evaluations_span_uq" ON "trace_evaluations" ("span_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_evaluations_agent_started_idx" ON "trace_evaluations" ("agent_id", "span_started_at");
