-- ADR-0190 slice I5: an engine run's worker runs ONLY in an executor's sandbox, and the run names that placement.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- When a runner asks to start a leased run's task (POST /v1/engine-runner/runs/:runId/task/input), the gateway
-- decides, in ONE transaction: the run's engine-run entitlement (an `agent` decision for an agent run, an
-- `engine_run` placement decision for an artifact scan), the `engine_worker` placement keyed to that decision's audit
-- id (ADR-0190 decision 7 through I2's requirement and I4's linked offer; the I4/I8 contract), and this column. A
-- refusal ends the run `not_run` (`isolation_unavailable`) in the same transaction; there is no other place the
-- worker can run. The column is set once: a run has at most one task placement, and a placement belongs to at most
-- one run (unique). Existing rows stay NULL (they never had a task: nothing is back-filled, ADR-0180).
ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "task_placement_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_task_placement_id_fk"
    FOREIGN KEY ("task_placement_id") REFERENCES "execution_placements"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engine_runs_task_placement_uq" ON "engine_runs" ("task_placement_id") WHERE "task_placement_id" IS NOT NULL;
--> statement-breakpoint
-- set once: a task placement is never replaced or cleared (the evidence it names stays the run's)
CREATE OR REPLACE FUNCTION "engine_runs_task_placement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."task_placement_id" IS NOT NULL AND NEW."task_placement_id" IS DISTINCT FROM OLD."task_placement_id" THEN
    RAISE EXCEPTION 'engine_runs.task_placement_id is set once (ADR-0190 I5)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "engine_runs_task_placement_guard" ON "engine_runs";
--> statement-breakpoint
CREATE TRIGGER "engine_runs_task_placement_guard" BEFORE UPDATE OF "task_placement_id" ON "engine_runs"
  FOR EACH ROW EXECUTE FUNCTION "engine_runs_task_placement_guard"();
