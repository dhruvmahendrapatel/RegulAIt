-- ADR-0242 phase 2 follow-up (lane L4, #843 security review): bind an admission scan's verdict to the bytes the
-- gateway placed. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- `engine_runs.target_subject_input_sha256` records, at task start, the sha256 of the one input file the gateway built
-- for a `subject` run (tools.json or SKILL.md). The engine's driver echoes the path and sha256 of every file it was
-- given; the run's end records a verdict only when that is exactly this one file, else `unknown` (which holds).
-- ADR-0200 exception: point-in-time evidence about one placement, so it is kept on the run (see the column comment).
-- The CHECK keeps it a sha256 and on subject runs only. No function or trigger is added.

ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "target_subject_input_sha256" text;
--> statement-breakpoint
COMMENT ON COLUMN "engine_runs"."target_subject_input_sha256" IS
  'ADR-0200 exception: point-in-time evidence. The sha256 of the one input file the gateway placed for a subject run, recorded at task start (ADR-0242, #843 security review)';
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_subject_input_sha_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_subject_input_sha_check"
  CHECK ("target_subject_input_sha256" IS NULL OR ("target_kind" = 'subject' AND "target_subject_input_sha256" ~ '^[0-9a-f]{64}$'));
