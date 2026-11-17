-- ADR-0345 (lane E26): the agent risk / control / proof registry's tenant state. The catalogue itself is code
-- (`AGENT_RISKS` in @regulait/shared); these tables hold an admin's schedule relaxations, the append-only proof
-- results (signed, hash-chained evidence) and what a failed proof raised.
CREATE TABLE IF NOT EXISTS "agent_risk_proof_settings" (
  "proof_key" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "interval_hours" integer,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_risk_proof_settings_key_check" CHECK ("proof_key" ~ '^[a-z_]+[.][a-z_]+$'),
  CONSTRAINT "agent_risk_proof_settings_interval_check" CHECK ("interval_hours" IS NULL OR "interval_hours" BETWEEN 1 AND 168)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_risk_proof_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proof_key" text NOT NULL,
  "catalog_version" integer NOT NULL,
  "trigger" text NOT NULL,
  "outcome" text NOT NULL,
  "run_as_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "redteam_run_id" uuid REFERENCES "redteam_runs"("id") ON DELETE SET NULL,
  -- no FK: audit_log is pruned by retention and nothing references it (the execution_placements.audit_id precedent)
  "audit_log_id" uuid NOT NULL,
  "content_hash" text NOT NULL,
  "signature" text,
  "signing_key_id" text,
  -- point-in-time snapshot of the engine's summary (ADR-0200 exception)
  "detail" jsonb NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_risk_proof_results_key_check" CHECK ("proof_key" ~ '^[a-z_]+[.][a-z_]+$'),
  CONSTRAINT "agent_risk_proof_results_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "agent_risk_proof_results_signature_check" CHECK (("signature" IS NULL) = ("signing_key_id" IS NULL)),
  CONSTRAINT "agent_risk_proof_results_detail_check" CHECK (jsonb_typeof("detail") = 'object'),
  CONSTRAINT "agent_risk_proof_results_order_check" CHECK ("finished_at" >= "started_at"),
  CONSTRAINT "agent_risk_proof_results_trigger_check" CHECK ("trigger" IN ('scheduled', 'manual')),
  CONSTRAINT "agent_risk_proof_results_outcome_check" CHECK ("outcome" IN ('pass', 'fail', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_risk_proof_results_audit_uq" ON "agent_risk_proof_results" ("audit_log_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_proof_results_latest_idx" ON "agent_risk_proof_results" ("proof_key", "finished_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_proof_results_redteam_run_idx" ON "agent_risk_proof_results" ("redteam_run_id");
--> statement-breakpoint
-- results are evidence: append-only. The SET NULL of a removed user or red-team run is let through by
-- regulait_refuse_mutation's own rule.
DROP TRIGGER IF EXISTS "agent_risk_proof_results_append_only" ON "agent_risk_proof_results";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_proof_results_append_only" BEFORE UPDATE OR DELETE ON "agent_risk_proof_results"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_risk_proof_results_no_truncate" ON public."agent_risk_proof_results";
--> statement-breakpoint
CREATE TRIGGER "agent_risk_proof_results_no_truncate" BEFORE TRUNCATE ON public."agent_risk_proof_results"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_risk_proof_followups" (
  "result_id" uuid PRIMARY KEY NOT NULL REFERENCES "agent_risk_proof_results"("id") ON DELETE CASCADE,
  "alert_id" uuid REFERENCES "governance_alerts"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_proof_followups_alert_idx" ON "agent_risk_proof_followups" ("alert_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_risk_proof_followups_approval_idx" ON "agent_risk_proof_followups" ("approval_id");
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_risk_proof_settings_admin" ON "agent_risk_proof_settings";
--> statement-breakpoint
CREATE POLICY "agent_risk_proof_settings_admin" ON "agent_risk_proof_settings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_risk_proof_results_admin" ON "agent_risk_proof_results";
--> statement-breakpoint
CREATE POLICY "agent_risk_proof_results_admin" ON "agent_risk_proof_results" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_followups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_risk_proof_followups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_risk_proof_followups_admin" ON "agent_risk_proof_followups";
--> statement-breakpoint
CREATE POLICY "agent_risk_proof_followups_admin" ON "agent_risk_proof_followups" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
