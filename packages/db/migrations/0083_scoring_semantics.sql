-- ADR-0072 — SCORING-SEMANTICS VERSIONING (the explicit baseline reset).
--
-- ADR-0072 corrects two scoring inversions:
--   1. ADR-0044 scored an `llm_as_judge` case with NO judge configured as 0 —
--      a MISSING INSTRUMENT recorded as a BAD MEASUREMENT. It now refuses the
--      run with a 422 before any row is written.
--   2. ADR-0057 scored a red-team probe whose dispatch was stopped by a
--      GOVERNANCE DECISION as a defeated probe — the platform holding and the
--      platform failing produced the same number. It is now a PLATFORM HOLD.
--
-- Both change what STORED NUMBERS MEAN without changing their shape, which is
-- the most dangerous kind of change a measurement system can make: every old
-- row still parses, still averages, still renders, and is no longer comparable
-- to a new one.
--
-- THIS MIGRATION IS THE HONEST RESET. It MARKS history; it does not delete or
-- rewrite it. Every existing eval_runs / redteam_runs row is stamped with
-- semantics version 1 (what actually produced it) via the column DEFAULT, and
-- the default is then moved to 2 for everything written afterwards. No stored
-- score, pass flag, aggregate, delta or gate verdict is touched. `audit_log` is
-- not touched at all, so ADR-0060's hash chain is unaffected by construction.
--
-- The consequence an operator must act on: A PINNED BASELINE THAT PREDATES THIS
-- MIGRATION MUST BE RE-PINNED. Baseline resolution now filters on the semantics
-- column, and a pinned-but-incomparable baseline FAILS the gate naming the run,
-- rather than being silently swapped for a different one.
--
-- `GET /v1/evals/scoring-semantics` reports the split and lists exactly which
-- pinned baselines are stranded.
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "scoring_semantics" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "scoring_semantics" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_scoring_semantics_check" CHECK ("eval_runs"."scoring_semantics" >= 1);--> statement-breakpoint
ALTER TABLE "redteam_runs" ADD COLUMN "scoring_semantics" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "redteam_runs" ALTER COLUMN "scoring_semantics" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "redteam_runs" ADD CONSTRAINT "redteam_runs_scoring_semantics_check" CHECK ("redteam_runs"."scoring_semantics" >= 1);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_runs_semantics_idx" ON "eval_runs" ("dataset_id","dataset_version","agent_id","scoring_semantics");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redteam_runs_semantics_idx" ON "redteam_runs" ("library_id","agent_id","scoring_semantics");
