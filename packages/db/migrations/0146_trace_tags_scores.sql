-- ADR-0173 batch 2c (F, foundation) — trace tags, trace scores, and the
-- indexes the new trace filters read.
--
-- trace_tags     key=value labels on a trace; one value per (trace, key).
--                Key shape and value length are enforced here as well as in
--                the API (TRACE_TAG_LIMITS in packages/shared/src/trace-filters.ts).
-- trace_scores   one numeric score and/or label per (source, source_ref_id,
--                name): annotation submissions, evaluator results, judge
--                verdicts and trace evaluations all land here, so a trace
--                filter or an OTel `gen_ai.evaluation.*` export reads ONE
--                table. Never a comment or any other content.
--
-- Both cascade from `traces`, so the §8.3 prune (which deletes traces) takes
-- their tags and scores with them; a score on a span cascades from the span.
CREATE TABLE IF NOT EXISTS "trace_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" uuid NOT NULL REFERENCES "traces"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "value" text DEFAULT '' NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trace_tags_key_ck" CHECK ("key" ~ '^[a-z0-9_.-]{1,64}$'),
  CONSTRAINT "trace_tags_value_ck" CHECK (char_length("value") <= 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trace_tags_trace_key_uq" ON "trace_tags" ("trace_id", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_tags_key_value_idx" ON "trace_tags" ("key", "value");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" uuid NOT NULL REFERENCES "traces"("id") ON DELETE CASCADE,
  "span_id" uuid REFERENCES "trace_spans"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "name" text NOT NULL,
  "value" double precision,
  "label" text,
  "source_ref_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trace_scores_source_ck" CHECK ("source" IN ('annotation', 'evaluator', 'judge', 'trace_eval')),
  CONSTRAINT "trace_scores_value_or_label_ck" CHECK ("value" IS NOT NULL OR "label" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trace_scores_source_ref_name_uq" ON "trace_scores" ("source", "source_ref_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_scores_trace_idx" ON "trace_scores" ("trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_scores_name_value_idx" ON "trace_scores" ("name", "value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_spans_agent_started_idx" ON "trace_spans" ("agent_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_spans_model_idx" ON "trace_spans" ("model");
--> statement-breakpoint
-- the `flagged` trace filter is an EXISTS over flagged evaluations of a trace
CREATE INDEX IF NOT EXISTS "trace_evaluations_trace_flagged_idx" ON "trace_evaluations" ("trace_id") WHERE "flagged";
