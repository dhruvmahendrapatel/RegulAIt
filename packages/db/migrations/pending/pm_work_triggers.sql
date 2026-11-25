-- ADR-0356 (builder lane E37, PR 1): work assigned from the PM tool. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. Nothing is backfilled: no connection has trigger settings, so every
-- connection keeps ignoring trigger signals until an admin turns them on (ADR-0180).
--
-- 1. `pm_trigger_settings`: one admin-managed row per connection that may start work from the PM tool.
-- 2. `pm_identity_links`: the admin's binding of a PM identity to an existing RegulAIt user (the ADR-0061 pattern).
-- 3. `pm_work_triggers`: one row per trigger, its state moving along PM_TRIGGER_TRANSITIONS
--    (@regulait/pm-provider). The CHECK holds the states and a BEFORE UPDATE trigger refuses any transition the
--    table does not declare, so the database enforces the same machine the gateway does.
--
-- Row-level security follows the ADR-0234 PM pattern (rls_pm_tables): no org or owner column, admin-managed
-- configuration plus a closed list of reasons. The webhook route runs under `approval_maintenance`: it reads the
-- settings and the links and records the triggers. Admins manage the settings and links. `pm_sync` (a principal step
-- on the write-back path, ADR-0356 PR 2) reads the settings and moves triggers. `migration` reaches everything.

CREATE TABLE IF NOT EXISTS "pm_trigger_settings" (
  "connection_id" uuid PRIMARY KEY NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "config" jsonb NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_trigger_settings_config_ck" CHECK (jsonb_typeof("config") = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_trigger_settings_agent_idx" ON "pm_trigger_settings" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_trigger_settings_project_idx" ON "pm_trigger_settings" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "pm_user_id" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "verified_source" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_identity_links_source_ck" CHECK ("verified_source" IN ('idp', 'scim', 'admin_asserted')),
  CONSTRAINT "pm_identity_links_pm_user_len_ck" CHECK (char_length("pm_user_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_identity_links_pm_user_uq" ON "pm_identity_links" ("connection_id", lower("pm_user_id"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_identity_links_user_uq" ON "pm_identity_links" ("connection_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_identity_links_user_idx" ON "pm_identity_links" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_work_triggers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "mechanism" text NOT NULL,
  "actor_pm_user_id" text,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "state" text DEFAULT 'received' NOT NULL,
  "outcome_code" text,
  "outcome_detail" text,
  "instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "delivery_content_sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_work_triggers_state_ck" CHECK ("state" IN ('received', 'accepted', 'denied', 'running', 'written_back', 'failed')),
  CONSTRAINT "pm_work_triggers_mechanism_ck" CHECK ("mechanism" IN ('assignment', 'mention', 'rule')),
  CONSTRAINT "pm_work_triggers_external_id_len_ck" CHECK (char_length("external_id") BETWEEN 1 AND 256),
  CONSTRAINT "pm_work_triggers_actor_len_ck" CHECK ("actor_pm_user_id" IS NULL OR char_length("actor_pm_user_id") BETWEEN 1 AND 200),
  CONSTRAINT "pm_work_triggers_outcome_len_ck" CHECK (
    ("outcome_code" IS NULL OR char_length("outcome_code") BETWEEN 1 AND 64)
    AND ("outcome_detail" IS NULL OR char_length("outcome_detail") BETWEEN 1 AND 2000)
  ),
  CONSTRAINT "pm_work_triggers_delivery_ck" CHECK ("delivery_content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_work_triggers_open_item_uq" ON "pm_work_triggers" ("connection_id", "external_id")
  WHERE "state" IN ('received', 'accepted', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_work_triggers_conn_created_idx" ON "pm_work_triggers" ("connection_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_work_triggers_instance_idx" ON "pm_work_triggers" ("instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_work_triggers_user_idx" ON "pm_work_triggers" ("user_id");
--> statement-breakpoint

-- The declared lifecycle, enforced at the database: the same table as PM_TRIGGER_TRANSITIONS. A row's identity
-- columns (connection, item, mechanism, actor, delivery) never change after insert.
CREATE OR REPLACE FUNCTION regulait_pm_work_trigger_transition() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.mechanism IS DISTINCT FROM OLD.mechanism
     OR NEW.actor_pm_user_id IS DISTINCT FROM OLD.actor_pm_user_id
     OR NEW.delivery_content_sha256 IS DISTINCT FROM OLD.delivery_content_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'regulait: a pm_work_triggers row''s identity columns cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'received' AND NEW.state IN ('accepted', 'denied', 'failed'))
    OR (OLD.state = 'accepted' AND NEW.state IN ('running', 'failed'))
    OR (OLD.state = 'running' AND NEW.state IN ('written_back', 'failed'))
    OR (OLD.state = 'denied' AND NEW.state IN ('written_back', 'failed'))
  ) THEN
    RAISE EXCEPTION 'regulait: pm_work_triggers cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS pm_work_triggers_transition ON pm_work_triggers;
--> statement-breakpoint
CREATE TRIGGER pm_work_triggers_transition BEFORE UPDATE ON pm_work_triggers
  FOR EACH ROW EXECUTE FUNCTION regulait_pm_work_trigger_transition();
--> statement-breakpoint
-- a table whose row trigger refuses some updates also refuses TRUNCATE, which fires no row trigger (migration 0185)
DROP TRIGGER IF EXISTS pm_work_triggers_no_truncate ON pm_work_triggers;
--> statement-breakpoint
CREATE TRIGGER pm_work_triggers_no_truncate BEFORE TRUNCATE ON pm_work_triggers
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint

ALTER TABLE pm_trigger_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_trigger_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_trigger_settings_select ON pm_trigger_settings;
--> statement-breakpoint
CREATE POLICY pm_trigger_settings_select ON pm_trigger_settings FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_trigger_settings_write ON pm_trigger_settings;
--> statement-breakpoint
CREATE POLICY pm_trigger_settings_write ON pm_trigger_settings FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

ALTER TABLE pm_identity_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_identity_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_identity_links_select ON pm_identity_links;
--> statement-breakpoint
CREATE POLICY pm_identity_links_select ON pm_identity_links FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_identity_links_write ON pm_identity_links;
--> statement-breakpoint
CREATE POLICY pm_identity_links_write ON pm_identity_links FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

ALTER TABLE pm_work_triggers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_work_triggers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_work_triggers_all ON pm_work_triggers;
--> statement-breakpoint
CREATE POLICY pm_work_triggers_all ON pm_work_triggers FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'migration'])
  );
