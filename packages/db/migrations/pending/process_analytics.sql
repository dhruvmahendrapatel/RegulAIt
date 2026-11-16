-- ADR-0342 (lane E23): process analytics read model. Hand-authored (never drizzle-kit generate), additive and idempotent.
--
-- A measured read model (ADR-0200 addendum) whose source of truth is `workflow_events`, replayed through the pure
-- workflow kernel against each instance's snapshotted definition. Nothing here is evidence; every row can be dropped and
-- rebuilt by the projector (`projectProcessAnalytics`).
--
-- Secure by default (ADR-0180): row-level security ENABLED and FORCED on all three tables.
--   - process_analytics_instances: an admin, `system_task` and `migration` read every row; any other principal reads
--     only instances of projects it is a member of (project_members). An instance with no project is admin-only.
--   - the template join and the stage spans: readable exactly when their instance row is (the policy reads the
--     instance table, which applies its own policy).
--   - every write: an admin (the audited refresh route) or `system_task` (the scheduler) only.
-- A transaction with no principal and no system context sees zero rows. No functions or triggers.

CREATE TABLE IF NOT EXISTS "process_analytics_instances" (
  "instance_id" uuid PRIMARY KEY NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "terminal_status" text,
  "last_event_at" timestamp with time zone NOT NULL,
  "event_count" integer NOT NULL,
  "replay_status" text NOT NULL,
  "source_updated_at" timestamp with time zone NOT NULL,
  "projected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "process_analytics_instances_replay_check" CHECK ("replay_status" IN ('ok', 'diverged', 'too_long')),
  CONSTRAINT "process_analytics_instances_ended_check" CHECK (("ended_at" IS NULL) = ("terminal_status" IS NULL)),
  CONSTRAINT "process_analytics_instances_terminal_check" CHECK ("terminal_status" IS NULL OR "terminal_status" IN ('completed', 'aborted', 'denied', 'rolled_back')),
  CONSTRAINT "process_analytics_instances_event_count_check" CHECK ("event_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_instances_project_started_idx" ON "process_analytics_instances" ("project_id", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_instances_started_idx" ON "process_analytics_instances" ("started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_instances_ended_idx" ON "process_analytics_instances" ("ended_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "process_analytics_instance_templates" (
  "instance_id" uuid NOT NULL REFERENCES "process_analytics_instances"("instance_id") ON DELETE CASCADE,
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  CONSTRAINT "process_analytics_instance_templates_pk" PRIMARY KEY ("instance_id", "template_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_instance_templates_template_idx" ON "process_analytics_instance_templates" ("template_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "process_analytics_stage_spans" (
  "instance_id" uuid NOT NULL REFERENCES "process_analytics_instances"("instance_id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "stage_id" text NOT NULL,
  "stage_type" text NOT NULL,
  "visit" integer NOT NULL,
  "entered_at" timestamp with time zone NOT NULL,
  "exited_at" timestamp with time zone,
  "wait_ms" bigint NOT NULL,
  "work_ms" bigint NOT NULL,
  "exit_kind" text,
  CONSTRAINT "process_analytics_stage_spans_pk" PRIMARY KEY ("instance_id", "seq"),
  CONSTRAINT "process_analytics_stage_spans_seq_check" CHECK ("seq" >= 0 AND "visit" >= 1),
  CONSTRAINT "process_analytics_stage_spans_ms_check" CHECK ("wait_ms" >= 0 AND "work_ms" >= 0),
  CONSTRAINT "process_analytics_stage_spans_exit_check" CHECK (("exited_at" IS NULL) = ("exit_kind" IS NULL)),
  CONSTRAINT "process_analytics_stage_spans_exit_kind_check" CHECK ("exit_kind" IS NULL OR "exit_kind" IN ('advanced', 'reworked', 'ended')),
  CONSTRAINT "process_analytics_stage_spans_order_check" CHECK ("exited_at" IS NULL OR "exited_at" >= "entered_at"),
  CONSTRAINT "process_analytics_stage_spans_stage_id_check" CHECK (char_length("stage_id") >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_stage_spans_stage_exited_idx" ON "process_analytics_stage_spans" ("stage_id", "exited_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "process_analytics_stage_spans_exited_idx" ON "process_analytics_stage_spans" ("exited_at");
--> statement-breakpoint
ALTER TABLE "process_analytics_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "process_analytics_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_instances_select" ON "process_analytics_instances";
--> statement-breakpoint
CREATE POLICY "process_analytics_instances_select" ON "process_analytics_instances" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR "project_id" IN (SELECT pm."project_id" FROM "project_members" pm WHERE pm."user_id" = (SELECT regulait_rls_user_id()))
);
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_instances_write" ON "process_analytics_instances";
--> statement-breakpoint
CREATE POLICY "process_analytics_instances_write" ON "process_analytics_instances" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "process_analytics_instance_templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "process_analytics_instance_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_instance_templates_select" ON "process_analytics_instance_templates";
--> statement-breakpoint
CREATE POLICY "process_analytics_instance_templates_select" ON "process_analytics_instance_templates" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "process_analytics_instances" p WHERE p."instance_id" = "process_analytics_instance_templates"."instance_id")
);
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_instance_templates_write" ON "process_analytics_instance_templates";
--> statement-breakpoint
CREATE POLICY "process_analytics_instance_templates_write" ON "process_analytics_instance_templates" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "process_analytics_stage_spans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "process_analytics_stage_spans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_stage_spans_select" ON "process_analytics_stage_spans";
--> statement-breakpoint
CREATE POLICY "process_analytics_stage_spans_select" ON "process_analytics_stage_spans" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "process_analytics_instances" p WHERE p."instance_id" = "process_analytics_stage_spans"."instance_id")
);
--> statement-breakpoint
DROP POLICY IF EXISTS "process_analytics_stage_spans_write" ON "process_analytics_stage_spans";
--> statement-breakpoint
CREATE POLICY "process_analytics_stage_spans_write" ON "process_analytics_stage_spans" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
