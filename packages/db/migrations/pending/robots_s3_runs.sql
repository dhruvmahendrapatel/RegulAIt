-- ADR-0364 S3 (lane E45): robot runs execute. Run evidence, the placement a run used, and the free-form settings
-- that have no default (owner decision pending: free-form browsing stays off until both are set).
--
-- Sorts after robots.sql (byte order: '.' < '_'), which creates robot_runs.
--
--  - robot_runs.execution_placement_id: the decision 7 placement the run executed under (set once, by the gateway).
--  - robot_run_evidence: one row per stored evidence item (a redacted screenshot, a download, the run's egress log).
--    The bytes live in the content-addressed store under `sha256/<hex>`; the row is append-only (no UPDATE, no
--    DELETE, no TRUNCATE): evidence leaves only by retention expiry, a later slice's recorded sweep.
--  - org_settings.freeform_browser_session_budget_usd / freeform_browser_max_run_minutes: NULL until an admin sets
--    them. NULL means free-form browser control is refused (fail closed); there is deliberately no default.

ALTER TABLE "robot_runs" ADD COLUMN IF NOT EXISTS "execution_placement_id" uuid REFERENCES "execution_placements"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_runs_placement_idx" ON "robot_runs" ("execution_placement_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_run_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "robot_run_id" uuid NOT NULL REFERENCES "robot_runs"("id") ON DELETE RESTRICT,
  "item" integer NOT NULL,
  "kind" text NOT NULL,
  "step" integer,
  "content_type" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "robot_run_evidence_item_uq" UNIQUE ("robot_run_id", "item"),
  CONSTRAINT "robot_run_evidence_kind_check" CHECK ("kind" IN ('screenshot', 'download', 'egress_log')),
  CONSTRAINT "robot_run_evidence_type_check" CHECK ("content_type" IN ('image/jpeg', 'application/octet-stream', 'text/plain')),
  CONSTRAINT "robot_run_evidence_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "robot_run_evidence_item_check" CHECK ("item" >= 0 AND "item" < 64),
  CONSTRAINT "robot_run_evidence_size_check" CHECK ("size_bytes" >= 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "robot_run_evidence_step_check" CHECK ("step" IS NULL OR ("step" >= 0 AND "step" <= 500))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_run_evidence_sha_idx" ON "robot_run_evidence" ("sha256");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION regulait_robot_run_evidence_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'robot run evidence is append-only (ADR-0364 §7)';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "robot_run_evidence_append_only" ON public."robot_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "robot_run_evidence_append_only" BEFORE UPDATE OR DELETE ON public."robot_run_evidence"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_run_evidence_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "robot_run_evidence_no_truncate" ON public."robot_run_evidence";
--> statement-breakpoint
CREATE TRIGGER "robot_run_evidence_no_truncate" BEFORE TRUNCATE ON public."robot_run_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_run_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- the run's readers (requester, robot owner, admin) read its evidence; only the gateway's system task writes it
DROP POLICY IF EXISTS robot_run_evidence_select ON "robot_run_evidence";
--> statement-breakpoint
CREATE POLICY robot_run_evidence_select ON "robot_run_evidence" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR EXISTS (SELECT 1 FROM "robot_runs" rr JOIN "robot_versions" v ON v."id" = rr."robot_version_id" JOIN "robots" r ON r."id" = v."robot_id"
    WHERE rr."id" = "robot_run_id" AND (rr."requested_by" = (SELECT regulait_rls_user_id()) OR r."owner_user_id" = (SELECT regulait_rls_user_id())))
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_run_evidence_insert ON "robot_run_evidence";
--> statement-breakpoint
CREATE POLICY robot_run_evidence_insert ON "robot_run_evidence" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "freeform_browser_session_budget_usd" double precision;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "freeform_browser_max_run_minutes" integer;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_freeform_browser_budget_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_freeform_browser_budget_check"
  CHECK ("freeform_browser_session_budget_usd" IS NULL OR ("freeform_browser_session_budget_usd" > 0 AND "freeform_browser_session_budget_usd" <= 1000));
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_freeform_browser_minutes_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_freeform_browser_minutes_check"
  CHECK ("freeform_browser_max_run_minutes" IS NULL OR ("freeform_browser_max_run_minutes" >= 1 AND "freeform_browser_max_run_minutes" <= 30));
