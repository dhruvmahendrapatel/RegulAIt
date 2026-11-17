-- ADR-0327 (lane E12, slice 3b): shadow mode for a rule-like step suggestion. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent. No function and no trigger.
--   rule_step_suggestions.status  gains 'shadow': the suggestion's rule is being measured against live traffic. While
--                                 in shadow a rescan refreshes nothing on the row, so the counts describe one rule.
--   rule_step_shadows             one row per shadow period of a suggestion (start, stop, and what was measured). The
--                                 counters are a measured read model of `trace_spans` (the source of truth), advanced
--                                 by `evaluated_through`; they hold counts only, never span content. At most one open
--                                 period per suggestion. Rows go with their suggestion (retention and erasure delete it).
-- Nothing here changes routing: the AI still answers every request.

ALTER TABLE "rule_step_suggestions" DROP CONSTRAINT IF EXISTS "rule_step_suggestions_status_check";
ALTER TABLE "rule_step_suggestions" ADD CONSTRAINT "rule_step_suggestions_status_check"
  CHECK ("status" IN ('suggested', 'shadow', 'dismissed'));

CREATE TABLE IF NOT EXISTS "rule_step_shadows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "suggestion_id" uuid NOT NULL REFERENCES "rule_step_suggestions"("id") ON DELETE CASCADE,
  "started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "stopped_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "stopped_at" timestamp with time zone,
  "evaluated_through" timestamp with time zone,
  "runs" integer DEFAULT 0 NOT NULL,
  "covered" integer DEFAULT 0 NOT NULL,
  "agreed" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "rule_step_shadows_counts_check" CHECK ("runs" >= 0 AND "covered" BETWEEN 0 AND "runs" AND "agreed" BETWEEN 0 AND "covered"),
  CONSTRAINT "rule_step_shadows_stop_check" CHECK ("stopped_at" IS NULL OR "stopped_at" >= "started_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "rule_step_shadows_open_uq" ON "rule_step_shadows" ("suggestion_id") WHERE "stopped_at" IS NULL;
CREATE INDEX IF NOT EXISTS "rule_step_shadows_suggestion_started_idx" ON "rule_step_shadows" ("suggestion_id", "started_at");
