-- ADR-0361 slice 1 (lane E42): read-only monitoring of sanctioned AI SaaS through the vendors' compliance APIs.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `ai_saas_monitor_policy`: the one org-level switch, OFF (ADR-0180), and the content-capture mode, `none` (text is
--   scanned in memory and never stored). Turning either up is a step-up, audited; `enabled` is refused under
--   REGULAIT_DEPLOY_MODE=air_gapped in code (ADR-0062).
-- - `ai_saas_monitor_connectors`: one row per vendor tenant an admin registered. New connectors are disabled.
--   `public_config` is a schema-validated configuration document (the ADR-0200 exception), validated per vendor in
--   `@regulait/shared` before it is written.
-- - `ai_saas_monitor_connector_tags`: a connector's compliance tags (a join table to `compliance_profiles.tag`, 3NF),
--   which drive its retention and PII mode through the §8.3 cascade. RESTRICT: a profile in use cannot be deleted out
--   from under the evidence it keeps.
-- - `ai_saas_monitor_credentials`: the vendor secret under REGULAIT_DATA_KEY (never plaintext, never returned,
--   destroyed on revoke). `scope_posture` is what the last token check found.
-- - `ai_saas_monitor_runs`: an open-first run ledger, one live run per connector. Errors are a fixed code plus a
--   RegulAIt-authored sentence, never vendor text.
-- - `ai_saas_interactions`: APPEND-ONLY EVIDENCE, one row per vendor interaction, idempotent on (connector, vendor id).
--   UPDATE is refused (except the data-key re-encryption walk rewriting only `content_ciphertext`, under the 0142
--   `regulait.secret_reencrypt` flag), TRUNCATE is refused (0185), and DELETE only for a row past the retention
--   sweep's transaction-local cutoff, checked against the database clock (the ADR-0302 pattern). `content_ciphertext` is NULL unless the
--   policy captured an ADR-0140-redacted copy (sealed under the data key).
-- - `ai_saas_interaction_findings`: counts only, one row per (interaction, detector, category); they go with their
--   interaction by ON DELETE CASCADE. UPDATE and TRUNCATE are refused.
-- - Row-level security (ADR-0234): every new table is ENABLED and FORCED, readable and writable only by an active admin
--   principal (regulait_rls_is_admin()), the scheduled sweep (`system_task`) and `migration`.

CREATE TABLE IF NOT EXISTS "ai_saas_monitor_policy" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "content_capture" text DEFAULT 'none' NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_saas_monitor_policy_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "ai_saas_monitor_policy_capture_check" CHECK ("content_capture" IN ('none', 'redacted'))
);
--> statement-breakpoint
INSERT INTO "ai_saas_monitor_policy" ("id", "enabled", "content_capture") VALUES ('singleton', false, 'none') ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_monitor_connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor" text NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "public_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "monitored_through" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_saas_monitor_connectors_vendor_check" CHECK ("vendor" IN ('m365_copilot', 'chatgpt_enterprise', 'claude_enterprise')),
  CONSTRAINT "ai_saas_monitor_connectors_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "ai_saas_monitor_connectors_public_config_check" CHECK (jsonb_typeof("public_config") = 'object' AND octet_length("public_config"::text) <= 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_monitor_connectors_name_uq" ON "ai_saas_monitor_connectors" (lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_monitor_connectors_enabled_idx" ON "ai_saas_monitor_connectors" ("enabled") WHERE "enabled";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_monitor_connector_tags" (
  "connector_id" uuid NOT NULL REFERENCES "ai_saas_monitor_connectors"("id") ON DELETE CASCADE,
  "profile_tag" text NOT NULL REFERENCES "compliance_profiles"("tag") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_saas_monitor_connector_tags_pk" PRIMARY KEY ("connector_id", "profile_tag")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_monitor_connector_tags_tag_idx" ON "ai_saas_monitor_connector_tags" ("profile_tag");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_monitor_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "ai_saas_monitor_connectors"("id") ON DELETE CASCADE,
  "secret_ciphertext" text,
  "scope_posture" text DEFAULT 'unverified' NOT NULL,
  "verified_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "ai_saas_monitor_credentials_scope_check" CHECK ("scope_posture" IN ('unverified', 'read_only', 'refused')),
  CONSTRAINT "ai_saas_monitor_credentials_live_secret_check" CHECK ("revoked_at" IS NOT NULL OR "secret_ciphertext" IS NOT NULL),
  CONSTRAINT "ai_saas_monitor_credentials_revoked_check" CHECK ("revoked_at" IS NULL OR "secret_ciphertext" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_monitor_credentials_live_uq"
  ON "ai_saas_monitor_credentials" ("connector_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_monitor_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "ai_saas_monitor_connectors"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "window_start" timestamp with time zone,
  "window_end" timestamp with time zone,
  "users_read" integer DEFAULT 0 NOT NULL,
  "pages" integer DEFAULT 0 NOT NULL,
  "interactions_seen" integer DEFAULT 0 NOT NULL,
  "interactions_new" integer DEFAULT 0 NOT NULL,
  "findings_created" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_detail" text,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "ai_saas_monitor_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
  CONSTRAINT "ai_saas_monitor_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'refused')),
  CONSTRAINT "ai_saas_monitor_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" IN (
    'disabled', 'air_gapped', 'no_credential', 'credential_refused', 'data_key_unavailable', 'egress_refused',
    'token_failed', 'missing_permission', 'unauthorized', 'forbidden', 'rate_limited', 'http_error', 'bad_response',
    'response_too_large', 'network_error', 'page_limit', 'interaction_limit', 'in_progress', 'internal')),
  CONSTRAINT "ai_saas_monitor_runs_error_detail_check" CHECK ("error_detail" IS NULL OR char_length("error_detail") <= 500),
  CONSTRAINT "ai_saas_monitor_runs_outcome_check" CHECK (("status" = 'failed' OR "status" = 'refused') = ("error_code" IS NOT NULL)),
  CONSTRAINT "ai_saas_monitor_runs_finished_check" CHECK (("status" = 'running') = ("finished_at" IS NULL)),
  CONSTRAINT "ai_saas_monitor_runs_counts_check" CHECK (
    "users_read" >= 0 AND "pages" >= 0 AND "interactions_seen" >= 0 AND "interactions_new" >= 0 AND "findings_created" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_monitor_runs_live_uq" ON "ai_saas_monitor_runs" ("connector_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_monitor_runs_connector_idx" ON "ai_saas_monitor_runs" ("connector_id", "started_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "ai_saas_monitor_connectors"("id") ON DELETE RESTRICT,
  "run_id" uuid NOT NULL REFERENCES "ai_saas_monitor_runs"("id") ON DELETE RESTRICT,
  "vendor_interaction_id" text NOT NULL,
  "conversation_ref" text,
  "kind" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "actor_ref" text,
  "app_ref" text,
  "content_sha256" text NOT NULL,
  "content_chars" integer NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "content_ciphertext" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_saas_interactions_vendor_id_check" CHECK (char_length("vendor_interaction_id") BETWEEN 1 AND 200),
  CONSTRAINT "ai_saas_interactions_conversation_check" CHECK ("conversation_ref" IS NULL OR char_length("conversation_ref") BETWEEN 1 AND 500),
  CONSTRAINT "ai_saas_interactions_kind_check" CHECK ("kind" IN ('prompt', 'response', 'other')),
  CONSTRAINT "ai_saas_interactions_actor_check" CHECK ("actor_ref" IS NULL OR char_length("actor_ref") BETWEEN 1 AND 100),
  CONSTRAINT "ai_saas_interactions_app_check" CHECK ("app_ref" IS NULL OR char_length("app_ref") BETWEEN 1 AND 200),
  CONSTRAINT "ai_saas_interactions_sha_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_saas_interactions_chars_check" CHECK ("content_chars" BETWEEN 0 AND 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_saas_interactions_dedup_uq" ON "ai_saas_interactions" ("connector_id", "vendor_interaction_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_interactions_connector_occurred_idx" ON "ai_saas_interactions" ("connector_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_interactions_received_idx" ON "ai_saas_interactions" ("received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_interactions_run_idx" ON "ai_saas_interactions" ("run_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ai_saas_interactions_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  raw text := coalesce(current_setting('regulait.ai_saas_retention_cutoff', true), '');
  cutoff timestamptz;
BEGIN
  -- the data-key re-encryption walk (ADR-0063, data-key-reencrypt.ts) rewrites the sealed copy under a new key: that
  -- UPDATE alone is let through, and only when nothing but a non-null `content_ciphertext` changes
  IF TG_OP = 'UPDATE' AND coalesce(current_setting('regulait.secret_reencrypt', true), '') = 'on'
     AND OLD.content_ciphertext IS NOT NULL AND NEW.content_ciphertext IS NOT NULL
     AND (to_jsonb(NEW) - 'content_ciphertext') = (to_jsonb(OLD) - 'content_ciphertext') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND raw <> '' THEN
    BEGIN
      cutoff := raw::timestamptz;
    EXCEPTION WHEN others THEN
      cutoff := NULL;
    END;
    IF cutoff IS NOT NULL AND cutoff < now() AND OLD.received_at < cutoff THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'ai_saas_interactions rows are append-only evidence (ADR-0361; only its retention sweep may delete a row past its floor)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_saas_interactions_guard" ON "ai_saas_interactions";
--> statement-breakpoint
CREATE TRIGGER "ai_saas_interactions_guard" BEFORE UPDATE OR DELETE ON "ai_saas_interactions"
  FOR EACH ROW EXECUTE FUNCTION "ai_saas_interactions_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_saas_interactions_no_truncate" ON public."ai_saas_interactions";
--> statement-breakpoint
CREATE TRIGGER "ai_saas_interactions_no_truncate" BEFORE TRUNCATE ON public."ai_saas_interactions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_saas_interaction_findings" (
  "interaction_id" uuid NOT NULL REFERENCES "ai_saas_interactions"("id") ON DELETE CASCADE,
  "detector" text NOT NULL,
  "category" text NOT NULL,
  "hit_count" integer NOT NULL,
  "action" text NOT NULL,
  CONSTRAINT "ai_saas_interaction_findings_pk" PRIMARY KEY ("interaction_id", "detector", "category"),
  CONSTRAINT "ai_saas_interaction_findings_detector_check" CHECK ("detector" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "ai_saas_interaction_findings_category_check" CHECK (char_length("category") BETWEEN 1 AND 100),
  CONSTRAINT "ai_saas_interaction_findings_count_check" CHECK ("hit_count" >= 1),
  CONSTRAINT "ai_saas_interaction_findings_action_check" CHECK ("action" IN ('block', 'warn', 'log'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_saas_interaction_findings_detector_idx" ON "ai_saas_interaction_findings" ("detector", "category");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "ai_saas_interaction_findings_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ai_saas_interaction_findings rows are evidence and are never changed (ADR-0361)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_saas_interaction_findings_guard" ON "ai_saas_interaction_findings";
--> statement-breakpoint
CREATE TRIGGER "ai_saas_interaction_findings_guard" BEFORE UPDATE ON "ai_saas_interaction_findings"
  FOR EACH ROW EXECUTE FUNCTION "ai_saas_interaction_findings_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_saas_interaction_findings_no_truncate" ON public."ai_saas_interaction_findings";
--> statement-breakpoint
CREATE TRIGGER "ai_saas_interaction_findings_no_truncate" BEFORE TRUNCATE ON public."ai_saas_interaction_findings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_policy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_policy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_monitor_policy_all ON "ai_saas_monitor_policy";
--> statement-breakpoint
CREATE POLICY ai_saas_monitor_policy_all ON "ai_saas_monitor_policy" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_connectors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_connectors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_monitor_connectors_all ON "ai_saas_monitor_connectors";
--> statement-breakpoint
CREATE POLICY ai_saas_monitor_connectors_all ON "ai_saas_monitor_connectors" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_connector_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_connector_tags" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_monitor_connector_tags_all ON "ai_saas_monitor_connector_tags";
--> statement-breakpoint
CREATE POLICY ai_saas_monitor_connector_tags_all ON "ai_saas_monitor_connector_tags" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_monitor_credentials_all ON "ai_saas_monitor_credentials";
--> statement-breakpoint
CREATE POLICY ai_saas_monitor_credentials_all ON "ai_saas_monitor_credentials" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_monitor_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_monitor_runs_all ON "ai_saas_monitor_runs";
--> statement-breakpoint
CREATE POLICY ai_saas_monitor_runs_all ON "ai_saas_monitor_runs" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_interactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_interactions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_interactions_all ON "ai_saas_interactions";
--> statement-breakpoint
CREATE POLICY ai_saas_interactions_all ON "ai_saas_interactions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_saas_interaction_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_saas_interaction_findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ai_saas_interaction_findings_all ON "ai_saas_interaction_findings";
--> statement-breakpoint
CREATE POLICY ai_saas_interaction_findings_all ON "ai_saas_interaction_findings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
