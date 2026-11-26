-- ADR-0356 (builder lane E37, PR 3): Atlassian Rovo-agent and Remote MCP audit events as read-only evidence.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Nothing is backfilled.
--
-- 1. `pm_audit_sources`: an admin's read-only feed of an Atlassian organisation's audit log, on a PM connection. Off
--    by default. The org API key is stored encrypted.
-- 2. `pm_audit_events`: one stored event, append-only third-party evidence (UPDATE, DELETE and TRUNCATE refused).
--
-- Row-level security on the ADR-0234 PM pattern: an admin manages the sources and reads the events; the poll runs
-- under `system_task` (the scheduler job) or as an admin (the manual poll), so `system_task` reads the sources, moves
-- their cursor and appends events. `migration` reaches everything.

CREATE TABLE IF NOT EXISTS "pm_audit_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE RESTRICT,
  "org_id" text NOT NULL,
  "base_url" text NOT NULL,
  "api_key_ciphertext" text NOT NULL,
  "action_filters" jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "cursor" text,
  "last_polled_at" timestamp with time zone,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_audit_sources_org_len_ck" CHECK (char_length("org_id") BETWEEN 1 AND 200),
  CONSTRAINT "pm_audit_sources_filters_ck" CHECK (jsonb_typeof("action_filters") = 'array'),
  CONSTRAINT "pm_audit_sources_cursor_len_ck" CHECK ("cursor" IS NULL OR char_length("cursor") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_audit_sources_conn_org_uq" ON "pm_audit_sources" ("connection_id", "org_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "pm_audit_sources"("id") ON DELETE RESTRICT,
  "event_id" text NOT NULL,
  "action" text NOT NULL,
  "actor_account_id" text,
  "attributes" jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "record_sha256" text NOT NULL,
  "audit_log_id" uuid NOT NULL,
  CONSTRAINT "pm_audit_events_event_len_ck" CHECK (char_length("event_id") BETWEEN 1 AND 200),
  CONSTRAINT "pm_audit_events_action_len_ck" CHECK (char_length("action") BETWEEN 1 AND 200),
  CONSTRAINT "pm_audit_events_sha_ck" CHECK ("record_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_audit_events_dedup_uq" ON "pm_audit_events" ("source_id", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_audit_events_source_observed_idx" ON "pm_audit_events" ("source_id", "observed_at" DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pm_audit_events_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'pm_audit_events rows are append-only third-party evidence (ADR-0356)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pm_audit_events_guard" ON "pm_audit_events";
--> statement-breakpoint
CREATE TRIGGER "pm_audit_events_guard" BEFORE UPDATE OR DELETE ON "pm_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "pm_audit_events_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pm_audit_events_no_truncate" ON public."pm_audit_events";
--> statement-breakpoint
CREATE TRIGGER "pm_audit_events_no_truncate" BEFORE TRUNCATE ON public."pm_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE pm_audit_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_audit_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_audit_sources_select ON pm_audit_sources;
--> statement-breakpoint
CREATE POLICY pm_audit_sources_select ON pm_audit_sources FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_audit_sources_write ON pm_audit_sources;
--> statement-breakpoint
CREATE POLICY pm_audit_sources_write ON pm_audit_sources FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE pm_audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_audit_events_select ON pm_audit_events;
--> statement-breakpoint
CREATE POLICY pm_audit_events_select ON pm_audit_events FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_audit_events_insert ON pm_audit_events;
--> statement-breakpoint
CREATE POLICY pm_audit_events_insert ON pm_audit_events FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
