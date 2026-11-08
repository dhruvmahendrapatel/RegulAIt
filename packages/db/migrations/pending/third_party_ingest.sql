-- ADR-0261 (backlog P37): third-party security telemetry ingest, first kind Cisco DefenseClaw's HTTP JSONL log export
-- (schema family v8). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `third_party_ingest_sources`: a customer's DefenseClaw deployment. Off by default (ADR-0180); enabling it is a
--    `settings_relax` step-up, audited. At most one write-only credential (`rgti_`), stored as its sha256 hash only.
-- 2. `third_party_ingest_records`: one row per accepted record. APPEND-ONLY EVIDENCE: the guard below refuses UPDATE and
--    DELETE, and a statement trigger refuses TRUNCATE (the 0185 pattern). The unique (source_id, record_id) pair is the
--    dedup the exporter's docs require ("consumers deduplicate on the record ID"). `attributes` is the ADR-0200
--    verbatim-external-payload exception: allow-listed, bounded and scrubbed before the insert; user identity, paths,
--    prompts and responses never reach it. The host name is replaced by the ADR-0195 device pseudonym.
--    `audit_log_id` names the audit-chain row of the batch the record arrived in (audit_log carries no FKs by design).
-- 3. `third_party_ingest_record_findings`: which shadow-AI finding a record opened or widened. A join table, because
--    findings are deleted by endpoint retention while evidence rows are not.
-- 4. `shadow_ai_imports.kind` gains 'defenseclaw_export': each accepted batch that touches findings is one import row.
--
-- One new function, pinned to `search_path = pg_catalog, public, pg_temp` (0185). The deployment is single-tenant, so
-- like the other register tables (0281) there is no tenant column to put row-level security on.

CREATE TABLE IF NOT EXISTS "third_party_ingest_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "schema_family" text DEFAULT 'v8' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "token_hash" text,
  "token_issued_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "third_party_ingest_sources_kind_check" CHECK ("kind" IN ('defenseclaw')),
  CONSTRAINT "third_party_ingest_sources_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "third_party_ingest_sources_schema_family_check" CHECK ("schema_family" IN ('v8')),
  CONSTRAINT "third_party_ingest_sources_token_hash_check" CHECK ("token_hash" IS NULL OR "token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "third_party_ingest_sources_token_issued_check" CHECK (("token_hash" IS NULL) = ("token_issued_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "third_party_ingest_sources_token_hash_uq" ON "third_party_ingest_sources" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "third_party_ingest_sources_name_uq" ON "third_party_ingest_sources" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "third_party_ingest_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "third_party_ingest_sources"("id") ON DELETE RESTRICT,
  "record_id" text NOT NULL,
  "bucket" text NOT NULL,
  "event_name" text,
  "severity" text,
  "action" text,
  "connector" text,
  "device_pseudonym" text,
  "attributes" jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "record_sha256" text NOT NULL,
  "batch_sha256" text NOT NULL,
  "audit_log_id" uuid NOT NULL,
  CONSTRAINT "third_party_ingest_records_record_id_check" CHECK (char_length("record_id") BETWEEN 1 AND 128),
  CONSTRAINT "third_party_ingest_records_bucket_check" CHECK ("bucket" IN (
    'compliance.activity', 'security.finding', 'guardrail.evaluation', 'enforcement.action', 'model.io',
    'tool.activity', 'asset.scan', 'asset.lifecycle', 'network.egress', 'agent.lifecycle', 'ai.discovery',
    'telemetry.ingest', 'platform.health', 'diagnostic')),
  CONSTRAINT "third_party_ingest_records_severity_check" CHECK ("severity" IS NULL OR "severity" IN (
    'critical', 'high', 'medium', 'low', 'info', 'error')),
  CONSTRAINT "third_party_ingest_records_event_name_check" CHECK ("event_name" IS NULL OR char_length("event_name") BETWEEN 1 AND 96),
  CONSTRAINT "third_party_ingest_records_action_check" CHECK ("action" IS NULL OR char_length("action") BETWEEN 1 AND 32),
  CONSTRAINT "third_party_ingest_records_connector_check" CHECK ("connector" IS NULL OR char_length("connector") BETWEEN 1 AND 64),
  CONSTRAINT "third_party_ingest_records_device_check" CHECK ("device_pseudonym" IS NULL OR char_length("device_pseudonym") BETWEEN 1 AND 64),
  CONSTRAINT "third_party_ingest_records_attributes_check" CHECK (jsonb_typeof("attributes") = 'object' AND octet_length("attributes"::text) <= 8192),
  CONSTRAINT "third_party_ingest_records_record_sha_check" CHECK ("record_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "third_party_ingest_records_batch_sha_check" CHECK ("batch_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "third_party_ingest_records_dedup_uq" ON "third_party_ingest_records" ("source_id", "record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "third_party_ingest_records_source_received_idx" ON "third_party_ingest_records" ("source_id", "received_at" DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "third_party_ingest_records_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'third_party_ingest_records rows are append-only third-party evidence (ADR-0261)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "third_party_ingest_records_guard" ON "third_party_ingest_records";
--> statement-breakpoint
CREATE TRIGGER "third_party_ingest_records_guard" BEFORE UPDATE OR DELETE ON "third_party_ingest_records"
  FOR EACH ROW EXECUTE FUNCTION "third_party_ingest_records_guard"();
--> statement-breakpoint
-- a TRUNCATE skips every row trigger: refused that way too (0185's pattern)
DROP TRIGGER IF EXISTS "third_party_ingest_records_no_truncate" ON public."third_party_ingest_records";
--> statement-breakpoint
CREATE TRIGGER "third_party_ingest_records_no_truncate" BEFORE TRUNCATE ON public."third_party_ingest_records"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "third_party_ingest_record_findings" (
  "record_id" uuid NOT NULL REFERENCES "third_party_ingest_records"("id") ON DELETE CASCADE,
  "finding_id" uuid NOT NULL REFERENCES "shadow_ai_findings"("id") ON DELETE CASCADE,
  CONSTRAINT "third_party_ingest_record_findings_pk" PRIMARY KEY ("record_id", "finding_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "third_party_ingest_record_findings_finding_idx" ON "third_party_ingest_record_findings" ("finding_id");
--> statement-breakpoint
ALTER TABLE "shadow_ai_imports" DROP CONSTRAINT IF EXISTS "shadow_ai_imports_kind_ck";
--> statement-breakpoint
ALTER TABLE "shadow_ai_imports" ADD CONSTRAINT "shadow_ai_imports_kind_ck" CHECK ("kind" IN (
  'egress_log', 'code_scan', 'saas_export', 'self_reported',
  'repo_scan', 'cloud_inventory', 'cloud_audit_log', 'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory', 'idp_app_grant', 'ml_platform_inventory',
  'defenseclaw_export'));
