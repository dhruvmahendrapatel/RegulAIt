-- ADR-0217: automatic re-test after a model change (P16). Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent.
--
-- 1. `org_settings.mrm_auto_retest_enabled`, default false (ADR-0180: the feature spends model tokens, so it is
--    off until an admin turns it on with a step-up; nothing is backfilled).
-- 2. `mrm_retest_runs`: one row per suite re-run for one drift of one card. The unique index is the claim: a
--    drift is re-tested at most once per suite however often the sweep runs. `card_approval_id` links the result
--    to the re-certification request it is evidence for. No function or trigger is added, so the 0185 guard
--    (pinned search_path, TRUNCATE refusal on append-only tables) has nothing new to check.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "mrm_auto_retest_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mrm_retest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "drift_key" text NOT NULL,
  "kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_name" text NOT NULL,
  "run_as_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "eval_run_id" uuid REFERENCES "eval_runs"("id") ON DELETE SET NULL,
  "redteam_run_id" uuid REFERENCES "redteam_runs"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "reason" text,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "card_approval_id" uuid REFERENCES "model_card_approvals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "mrm_retest_runs_kind_check" CHECK ("kind" IN ('eval', 'redteam')),
  CONSTRAINT "mrm_retest_runs_status_check" CHECK ("status" IN ('running', 'passed', 'failed_gate', 'reported', 'refused', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mrm_retest_runs_drift_uq" ON "mrm_retest_runs" ("card_id", "drift_key", "kind", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mrm_retest_runs_card_idx" ON "mrm_retest_runs" ("card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mrm_retest_runs_approval_idx" ON "mrm_retest_runs" ("card_approval_id");
