-- ADR-0322 slice 2 (lane E7): opt-in, per-tenant read-only pull of vendor usage and cost data. Hand-authored (never
-- drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `vendor_usage_pull_policy`: the one org-level switch. OFF (ADR-0180); turning it on is a step-up, audited, and is
--   refused under REGULAIT_DEPLOY_MODE=air_gapped in code (ADR-0062).
-- - `vendor_usage_connectors`: one row per vendor account an admin registered. New connectors are disabled.
-- - `vendor_usage_credentials`: the vendor key under REGULAIT_DATA_KEY (never plaintext, never returned, destroyed on
--   revoke). A key the vendor cannot scope read-only is `write_capable` and needs a recorded acknowledgement.
-- - `vendor_usage_pull_runs`: open-first run ledger. Errors are a fixed code plus RegulAIt-authored detail, never
--   vendor response text, so no third-party bytes (or an echoed key) land in this table.
-- - `cost_import_batches.origin` and three `imported_cost_lines` columns: pulled lines are ordinary imported lines
--   (basis stays 'imported'); `(pull_connector_id, fact_key)` makes a re-pull an upsert, and `overlaps_metered`
--   marks spend billed to a key the gateway itself holds, which the consolidated read excludes and discloses.
-- - The deployment is single-tenant, so like the other register tables (0281) there is no tenant column for RLS.
-- No new functions or refusal triggers.

CREATE TABLE IF NOT EXISTS "vendor_usage_pull_policy" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_usage_pull_policy_singleton_check" CHECK ("id" = 'singleton')
);
--> statement-breakpoint
INSERT INTO "vendor_usage_pull_policy" ("id", "enabled") VALUES ('singleton', false) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_usage_connectors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor" text NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "public_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pulled_through" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_usage_connectors_vendor_check"
    CHECK ("vendor" IN ('anthropic', 'openai', 'github_copilot', 'cursor', 'openai_codex', 'aws_cur')),
  CONSTRAINT "vendor_usage_connectors_public_config_check" CHECK (jsonb_typeof("public_config") = 'object'),
  CONSTRAINT "vendor_usage_connectors_name_check" CHECK (char_length("name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_usage_connectors_name_uq" ON "vendor_usage_connectors" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_usage_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "vendor_usage_connectors"("id") ON DELETE CASCADE,
  "secret_ciphertext" text,
  "scope_posture" text NOT NULL,
  "write_capable_acknowledged_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "vendor_usage_credentials_scope_check" CHECK ("scope_posture" IN ('read_only', 'write_capable', 'unverified')),
  CONSTRAINT "vendor_usage_credentials_ack_check"
    CHECK ("scope_posture" <> 'write_capable' OR "write_capable_acknowledged_at" IS NOT NULL),
  CONSTRAINT "vendor_usage_credentials_live_secret_check" CHECK ("revoked_at" IS NOT NULL OR "secret_ciphertext" IS NOT NULL),
  CONSTRAINT "vendor_usage_credentials_revoked_check" CHECK ("revoked_at" IS NULL OR "secret_ciphertext" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_usage_credentials_live_uq"
  ON "vendor_usage_credentials" ("connector_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_usage_pull_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connector_id" uuid NOT NULL REFERENCES "vendor_usage_connectors"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "window_start" timestamp with time zone,
  "window_end" timestamp with time zone,
  "batch_id" uuid REFERENCES "cost_import_batches"("id") ON DELETE SET NULL,
  "pages" integer DEFAULT 0 NOT NULL,
  "lines_upserted" integer DEFAULT 0 NOT NULL,
  "overlap_lines" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_detail" text,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "vendor_usage_pull_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
  CONSTRAINT "vendor_usage_pull_runs_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'refused')),
  CONSTRAINT "vendor_usage_pull_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" IN (
    'disabled', 'air_gapped', 'no_credential', 'data_key_unavailable', 'egress_refused', 'unauthorized', 'forbidden',
    'rate_limited', 'http_error', 'bad_response', 'response_too_large', 'network_error', 'page_limit', 'scan_blocked', 'internal')),
  CONSTRAINT "vendor_usage_pull_runs_error_detail_check" CHECK ("error_detail" IS NULL OR char_length("error_detail") <= 500),
  CONSTRAINT "vendor_usage_pull_runs_outcome_check" CHECK (("status" IN ('failed', 'refused')) = ("error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_usage_pull_runs_connector_idx" ON "vendor_usage_pull_runs" ("connector_id", "started_at");
--> statement-breakpoint
ALTER TABLE "cost_import_batches" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'file' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cost_import_batches" ADD CONSTRAINT "cost_import_batches_origin_check" CHECK ("origin" IN ('file', 'pull'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "pull_connector_id" uuid
  REFERENCES "vendor_usage_connectors"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "fact_key" text;
--> statement-breakpoint
ALTER TABLE "imported_cost_lines" ADD COLUMN IF NOT EXISTS "overlaps_metered" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_pull_fact_check"
    CHECK (("pull_connector_id" IS NULL) = ("fact_key" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "imported_cost_lines_pull_fact_uq"
  ON "imported_cost_lines" ("pull_connector_id", "fact_key") WHERE "pull_connector_id" IS NOT NULL;
