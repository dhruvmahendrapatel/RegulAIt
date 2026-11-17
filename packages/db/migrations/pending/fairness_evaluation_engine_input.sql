-- ADR-0346 slice 2: the input file the gateway placed for one fairlearn engine run, pinned when the task starts (the
-- ADR-0242 subject-file pattern); the run's end counts the task's result only when it names exactly this sha256.
-- Hand-authored, additive. No functions or triggers. RLS: admin-only, plus the engine runner's task start and result
-- (credential_request) and the scheduler (system_task).
CREATE TABLE IF NOT EXISTS "fairness_engine_inputs" (
  "engine_run_id" uuid PRIMARY KEY NOT NULL REFERENCES "engine_runs"("id") ON DELETE CASCADE,
  "evaluation_id" uuid NOT NULL REFERENCES "fairness_evaluations"("id") ON DELETE RESTRICT,
  "input_sha256" text NOT NULL,
  "row_count" integer NOT NULL,
  "placed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_engine_inputs_sha256_check" CHECK ("input_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "fairness_engine_inputs_row_count_check" CHECK ("row_count" BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_engine_inputs_evaluation_idx" ON "fairness_engine_inputs" ("evaluation_id");
--> statement-breakpoint
ALTER TABLE "fairness_engine_inputs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fairness_engine_inputs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS fairness_engine_inputs_all ON "fairness_engine_inputs";
--> statement-breakpoint
CREATE POLICY fairness_engine_inputs_all ON "fairness_engine_inputs" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task', 'credential_request']));
