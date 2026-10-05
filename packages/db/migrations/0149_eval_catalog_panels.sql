-- ADR-0173 batch 2c (E) — evaluators: datasets from traces, automatic re-run on
-- a configuration change, and weighted judge panels with every verdict kept.
--
-- eval_runs
--   trigger 'config_change'    the drift sweep re-ran a pinned baseline because
--                               the agent's configuration hash changed
--   config_hash                 sha256 over the measured configuration (model,
--                               tier, system-prompt hash, custom provider)
--   config_change_of_run_id     the pinned baseline a config_change run re-ran;
--                               unique with config_hash, so each (baseline,
--                               configuration) pair runs at most once
--   baseline_pinned_by_user_id  who pinned the run as THE baseline; the
--                               config_change re-run runs as that person.
--                               Existing pins are attributed to the run's
--                               initiator, the best attribution on record.
--   judge_panel                 [{agentId, agentName, weight}] for a panel run
--   repetitions                 1..5 judge repetitions per case
--   score_ci                    the bootstrap interval on the mean score
-- eval_cases
--   source_trace_id / source_span_id   provenance of a case built from a
--                               trace span; FK-free on purpose (a dataset row
--                               is authored content and outlives the §8.3
--                               trace prune). Unique per dataset version.
-- eval_judge_verdicts          every judge's verdict on every case and
--                               repetition, kept even when the panel combines.
ALTER TABLE "eval_runs" DROP CONSTRAINT IF EXISTS "eval_runs_trigger_check";
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_trigger_check" CHECK ("trigger" IN ('manual','workflow','scheduled','config_change'));
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "config_hash" text;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "config_change_of_run_id" uuid REFERENCES "eval_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "baseline_pinned_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "judge_panel" jsonb;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "repetitions" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "score_ci" jsonb;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_repetitions_check" CHECK ("repetitions" >= 1 AND "repetitions" <= 5);
--> statement-breakpoint
UPDATE "eval_runs" SET "baseline_pinned_by_user_id" = "initiated_by_user_id" WHERE "is_baseline" AND "baseline_pinned_by_user_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_runs_config_change_uq" ON "eval_runs" ("config_change_of_run_id", "config_hash") WHERE "trigger" = 'config_change';
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN IF NOT EXISTS "source_trace_id" uuid;
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN IF NOT EXISTS "source_span_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_cases_source_span_uq" ON "eval_cases" ("dataset_id", "dataset_version", "source_span_id") WHERE "source_span_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_judge_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "eval_runs"("id") ON DELETE CASCADE,
  "case_id" uuid REFERENCES "eval_cases"("id") ON DELETE SET NULL,
  "judge_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "judge_name" text NOT NULL,
  "weight" double precision NOT NULL,
  "repetition" integer NOT NULL,
  "score" double precision,
  "passed" boolean,
  "rationale" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eval_judge_verdicts_weight_check" CHECK ("weight" > 0),
  CONSTRAINT "eval_judge_verdicts_repetition_check" CHECK ("repetition" >= 1 AND "repetition" <= 5),
  CONSTRAINT "eval_judge_verdicts_score_check" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1)),
  CONSTRAINT "eval_judge_verdicts_outcome_check" CHECK ("score" IS NOT NULL OR "error" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_judge_verdicts_uq" ON "eval_judge_verdicts" ("run_id", "case_id", "judge_name", "repetition");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_judge_verdicts_run_idx" ON "eval_judge_verdicts" ("run_id");
