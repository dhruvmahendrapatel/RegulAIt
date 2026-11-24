-- ADR-0312 (lane E2, G3): cost per outcome. Hand-authored (never drizzle-kit generate), additive and idempotent.
--
-- `cost_outcomes` is the outcome ledger: one row per merged pull request, finished workflow run, accepted change and
-- completed PM work item the recorder observed. Spend is not stored: the API reads it from `usage_events` (metered)
-- through the subject's orchestration runs at query time. Imported spend never joins an outcome (ADR-0069).
--
-- Secure by default (ADR-0180):
--   - append-only for the app role: no UPDATE, DELETE or TRUNCATE (the outcome is evidence);
--   - row-level security ENABLED and FORCED: an admin and the recorder (`system_task`) read every row, any other
--     principal reads only the outcomes of workflows it initiated, and only an admin or the recorder may insert.
--     A transaction with no principal and no system context sees zero rows.
--
-- The `usage_events` run-id index the spend join reads is built CONCURRENTLY by `runMigrations` (CONCURRENT_INDEXES,
-- slug `cost_outcomes`), never in this transaction. No functions or triggers. No row of an RLS table is read or
-- written here.

CREATE TABLE IF NOT EXISTS "cost_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "workflow_instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "orchestration_run_id" uuid REFERENCES "orchestration_runs"("id") ON DELETE SET NULL,
  "node_id" text,
  "pm_link_id" uuid REFERENCES "pm_links"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "initiator_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "merge_sha" text,
  "subject_status" text NOT NULL,
  "trigger" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cost_outcomes_kind_check" CHECK ("kind" IN ('merged_pr', 'workflow_run', 'accepted_change', 'completed_work_item')),
  CONSTRAINT "cost_outcomes_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
  CONSTRAINT "cost_outcomes_merge_sha_check" CHECK (("kind" = 'merged_pr') = ("merge_sha" IS NOT NULL)),
  CONSTRAINT "cost_outcomes_subject_check" CHECK ("kind" = 'completed_work_item' OR ("pm_link_id" IS NULL AND "node_id" IS NULL)),
  CONSTRAINT "cost_outcomes_node_id_check" CHECK ("node_id" IS NULL OR char_length("node_id") BETWEEN 1 AND 64),
  CONSTRAINT "cost_outcomes_merge_sha_len_check" CHECK ("merge_sha" IS NULL OR char_length("merge_sha") BETWEEN 1 AND 128),
  CONSTRAINT "cost_outcomes_subject_status_check" CHECK (char_length("subject_status") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_outcomes_instance_kind_uq" ON "cost_outcomes" ("kind", "workflow_instance_id")
  WHERE "kind" <> 'completed_work_item' AND "workflow_instance_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_outcomes_pm_link_uq" ON "cost_outcomes" ("pm_link_id")
  WHERE "kind" = 'completed_work_item' AND "pm_link_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_outcomes_observed_idx" ON "cost_outcomes" ("observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_outcomes_project_observed_idx" ON "cost_outcomes" ("project_id", "observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_outcomes_initiator_idx" ON "cost_outcomes" ("initiator_user_id", "observed_at");
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "cost_outcomes" FROM regulait_app;
--> statement-breakpoint
ALTER TABLE "cost_outcomes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cost_outcomes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS cost_outcomes_select ON "cost_outcomes";
--> statement-breakpoint
CREATE POLICY cost_outcomes_select ON "cost_outcomes" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR "initiator_user_id" = (SELECT regulait_rls_user_id())
);
--> statement-breakpoint
DROP POLICY IF EXISTS cost_outcomes_insert ON "cost_outcomes";
--> statement-breakpoint
CREATE POLICY cost_outcomes_insert ON "cost_outcomes" FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
