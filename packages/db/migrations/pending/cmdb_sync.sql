-- ADR-0358 (lane E39): CMDB sync of the AI asset inventory (ServiceNow first, behind a vendor-neutral adapter).
--
-- cmdb_connectors   one CMDB; created disabled, export only (read_back_ownership off), an https origin
-- cmdb_credentials  the integration credential, a data-key envelope; one live per connector; NULL once revoked
-- cmdb_sync_runs    one pass, open-first; at most one running per connector; a fixed error-code vocabulary
-- cmdb_ci_links     the idempotency ledger: (connector, source key) -> CI sys_id and the hash of the last payload sent,
--                   plus the recorded ownership read-back (never applied to RegulAIt's own owner fields)
--
-- Row-level security, ENABLED and FORCED on every table: an active admin principal (regulait_rls_is_admin()) and the
-- `system_task` and `migration` reasons only.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "cmdb_connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "instance_url" text NOT NULL,
  "source_name" text NOT NULL,
  "ci_classes" jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "read_back_ownership" boolean DEFAULT false NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cmdb_connectors_kind_check" CHECK ("kind" IN ('servicenow')),
  CONSTRAINT "cmdb_connectors_url_check" CHECK ("instance_url" ~ '^https://[^/?#@]+$'),
  CONSTRAINT "cmdb_connectors_ci_classes_check" CHECK (jsonb_typeof("ci_classes") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cmdb_connectors_name_uq" ON "cmdb_connectors" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cmdb_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "cmdb_connectors"("id") ON DELETE CASCADE,
  "username" text NOT NULL,
  "secret_ciphertext" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "cmdb_credentials_live_secret_check" CHECK (("revoked_at" IS NULL) = ("secret_ciphertext" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cmdb_credentials_live_uq" ON "cmdb_credentials" ("connector_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cmdb_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "cmdb_connectors"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "status" text NOT NULL,
  "initiated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "items_examined" integer DEFAULT 0 NOT NULL,
  "items_pushed" integer DEFAULT 0 NOT NULL,
  "items_unchanged" integer DEFAULT 0 NOT NULL,
  "items_failed" integer DEFAULT 0 NOT NULL,
  "ownership_read" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  CONSTRAINT "cmdb_sync_runs_trigger_check" CHECK ("trigger" IN ('manual', 'schedule')),
  CONSTRAINT "cmdb_sync_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'refused')),
  CONSTRAINT "cmdb_sync_runs_finished_check" CHECK (("status" = 'running') = ("finished_at" IS NULL)),
  CONSTRAINT "cmdb_sync_runs_error_check" CHECK (("status" = 'failed' OR "status" = 'refused') = ("error_code" IS NOT NULL)),
  CONSTRAINT "cmdb_sync_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" IN ('in_progress', 'disabled', 'air_gapped', 'no_credential', 'no_data_key', 'secret_unreadable', 'egress_blocked', 'unauthorized', 'http_error', 'rate_limited', 'bad_response', 'network', 'timeout', 'stale', 'internal'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cmdb_sync_runs_connector_idx" ON "cmdb_sync_runs" ("connector_id", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cmdb_sync_runs_running_uq" ON "cmdb_sync_runs" ("connector_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cmdb_ci_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "cmdb_connectors"("id") ON DELETE CASCADE,
  "asset_kind" text NOT NULL,
  "source_key" text NOT NULL,
  "ci_class" text NOT NULL,
  "ci_sys_id" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "last_pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_run_id" uuid REFERENCES "cmdb_sync_runs"("id") ON DELETE SET NULL,
  "cmdb_owner_email" text,
  "cmdb_owner_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "ownership_read_at" timestamp with time zone,
  CONSTRAINT "cmdb_ci_links_asset_kind_check" CHECK ("asset_kind" IN ('agent', 'mcp_server', 'model', 'endpoint')),
  CONSTRAINT "cmdb_ci_links_sha_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "cmdb_ci_links_sys_id_check" CHECK ("ci_sys_id" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cmdb_ci_links_connector_key_uq" ON "cmdb_ci_links" ("connector_id", "source_key");
--> statement-breakpoint
ALTER TABLE "cmdb_connectors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cmdb_connectors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cmdb_connectors_admin" ON "cmdb_connectors";
--> statement-breakpoint
CREATE POLICY "cmdb_connectors_admin" ON "cmdb_connectors" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "cmdb_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cmdb_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cmdb_credentials_admin" ON "cmdb_credentials";
--> statement-breakpoint
CREATE POLICY "cmdb_credentials_admin" ON "cmdb_credentials" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "cmdb_sync_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cmdb_sync_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cmdb_sync_runs_admin" ON "cmdb_sync_runs";
--> statement-breakpoint
CREATE POLICY "cmdb_sync_runs_admin" ON "cmdb_sync_runs" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "cmdb_ci_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cmdb_ci_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cmdb_ci_links_admin" ON "cmdb_ci_links";
--> statement-breakpoint
CREATE POLICY "cmdb_ci_links_admin" ON "cmdb_ci_links" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
