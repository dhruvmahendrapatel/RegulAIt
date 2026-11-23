-- ADR-0232 §3–§5 (lane E49 slice 1): pipeline runs over ADR-0341's published workflow-template versions.
-- Named to sort after `workflow_template_builder.sql` (it references workflow_template_versions).
-- The instance CHECK spells its states without IN, so the one CHECK of the status column is the machine's (ADR-0348 test).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. No change to an existing
-- column.
--
-- 1. `pipeline_runs`: one governed run of one published template version. The run never executes anything itself:
--    it is started through the workflow engine's one instance-creation path, and `workflow_instance_id` is the
--    instance that path created. `status` is PIPELINE_RUN_MACHINE (packages/shared/src/state-machines.ts); the
--    settling states are a read model of `workflow_instances.status` (the source of truth), written once when the
--    instance is seen to be terminal. The template is reached through the version (no copy of it here).
--    Run rows are evidence: never deleted, and their identity columns are frozen once written.
-- 2. `pipeline_run_steps`: append-only. The plan the run started with: one row per stage of the instance's merged
--    definition, with the catalogue step type and governance class it ran under (a point-in-time snapshot; the live
--    status of each step stays in the instance state). Later slices append attempts.
-- RLS: the requester and an admin read a run; only an admin request or the system writes one.
CREATE TABLE IF NOT EXISTS "pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_version_id" uuid NOT NULL REFERENCES "workflow_template_versions"("id") ON DELETE RESTRICT,
  "workflow_instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE RESTRICT,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "idempotency_key" text,
  "status" text DEFAULT 'requested' NOT NULL,
  "refusal_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "pipeline_runs_trigger_check" CHECK ("trigger" IN ('manual')),
  CONSTRAINT "pipeline_runs_status_check" CHECK ("status" IN ('requested', 'running', 'succeeded', 'failed', 'cancelled', 'refused')),
  CONSTRAINT "pipeline_runs_idempotency_key_check" CHECK ("idempotency_key" IS NULL OR "idempotency_key" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "pipeline_runs_refusal_code_check" CHECK ("refusal_code" IS NULL OR "refusal_code" ~ '^[a-z_]{1,64}$'),
  CONSTRAINT "pipeline_runs_instance_check" CHECK (("status" = 'requested' OR "status" = 'refused') = ("workflow_instance_id" IS NULL)),
  CONSTRAINT "pipeline_runs_refusal_check" CHECK (("status" = 'refused') = ("refusal_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_runs_instance_uq" ON "pipeline_runs" ("workflow_instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_runs_idempotency_uq" ON "pipeline_runs" ("requested_by", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_status_created_idx" ON "pipeline_runs" ("status", "created_at" DESC, "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_requested_by_idx" ON "pipeline_runs" ("requested_by", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_version_idx" ON "pipeline_runs" ("template_version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_project_idx" ON "pipeline_runs" ("project_id");
--> statement-breakpoint
-- a run moves only along PIPELINE_RUN_MACHINE's edges, its identity is frozen, and it is never deleted
CREATE OR REPLACE FUNCTION regulait_pipeline_run_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pipeline run % is evidence and is never deleted (ADR-0232 §5)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('running', 'refused'))
    OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'pipeline run % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.trigger IS DISTINCT FROM OLD.trigger OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.workflow_instance_id IS NOT NULL AND NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at)
    OR (OLD.refusal_code IS NOT NULL AND NEW.refusal_code IS DISTINCT FROM OLD.refusal_code) THEN
    RAISE EXCEPTION 'pipeline run % has frozen columns', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pipeline_runs_guard" ON "pipeline_runs";
--> statement-breakpoint
CREATE TRIGGER "pipeline_runs_guard" BEFORE UPDATE OR DELETE ON "pipeline_runs"
  FOR EACH ROW EXECUTE FUNCTION regulait_pipeline_run_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pipeline_runs_no_truncate" ON public."pipeline_runs";
--> statement-breakpoint
CREATE TRIGGER "pipeline_runs_no_truncate" BEFORE TRUNCATE ON public."pipeline_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_run_steps" (
  "run_id" uuid NOT NULL REFERENCES "pipeline_runs"("id") ON DELETE RESTRICT,
  "ordinal" integer NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "stage_id" text NOT NULL,
  -- point-in-time snapshot (ADR-0200 exception): the catalogue step type and governance class this step started
  -- under, so a later catalogue change never rewrites what a past run was allowed to do
  "step_type" text NOT NULL,
  "writes" boolean NOT NULL,
  "auto_retry" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_run_steps_pk" PRIMARY KEY ("run_id", "ordinal", "attempt"),
  CONSTRAINT "pipeline_run_steps_ordinal_check" CHECK ("ordinal" >= 0 AND "ordinal" < 200),
  CONSTRAINT "pipeline_run_steps_attempt_check" CHECK ("attempt" >= 1),
  CONSTRAINT "pipeline_run_steps_stage_id_check" CHECK (char_length("stage_id") BETWEEN 1 AND 128),
  CONSTRAINT "pipeline_run_steps_step_type_check" CHECK ("step_type" ~ '^[a-z_]{1,64}$'),
  CONSTRAINT "pipeline_run_steps_retry_check" CHECK (NOT ("writes" AND "auto_retry"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_run_steps_stage_uq" ON "pipeline_run_steps" ("run_id", "stage_id", "attempt");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pipeline_run_steps_append_only" ON "pipeline_run_steps";
--> statement-breakpoint
CREATE TRIGGER "pipeline_run_steps_append_only" BEFORE UPDATE OR DELETE ON "pipeline_run_steps"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pipeline_run_steps_no_truncate" ON public."pipeline_run_steps";
--> statement-breakpoint
CREATE TRIGGER "pipeline_run_steps_no_truncate" BEFORE TRUNCATE ON public."pipeline_run_steps"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pipeline_runs_select ON "pipeline_runs";
--> statement-breakpoint
CREATE POLICY pipeline_runs_select ON "pipeline_runs" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR "requested_by" = (SELECT regulait_rls_user_id())
);
--> statement-breakpoint
DROP POLICY IF EXISTS pipeline_runs_write ON "pipeline_runs";
--> statement-breakpoint
CREATE POLICY pipeline_runs_write ON "pipeline_runs" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pipeline_run_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pipeline_run_steps_select ON "pipeline_run_steps";
--> statement-breakpoint
CREATE POLICY pipeline_run_steps_select ON "pipeline_run_steps" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR EXISTS (SELECT 1 FROM "pipeline_runs" r WHERE r."id" = "run_id" AND r."requested_by" = (SELECT regulait_rls_user_id()))
);
--> statement-breakpoint
DROP POLICY IF EXISTS pipeline_run_steps_write ON "pipeline_run_steps";
--> statement-breakpoint
CREATE POLICY pipeline_run_steps_write ON "pipeline_run_steps" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
