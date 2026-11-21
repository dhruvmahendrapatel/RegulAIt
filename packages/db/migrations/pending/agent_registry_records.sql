-- ADR-0314 (G6): import agents from vendor agent registries into the agent inventory.
-- Pending migration (ADR-0252): numbered at merge. Hand-authored (never drizzle-kit generate). Re-runnable: every
-- statement is idempotent.
--
-- Three read-only discovery source kinds in a new family `agent_registry`, behind its own org switch, OFF (ADR-0180
-- first-load posture; nothing is backfilled, no existing row changes):
--
--   agent_registry_entra      Microsoft Entra Agent ID identities (Graph v1.0) and, when the target asks, the
--                             Agent 365 catalogue (Graph copilot/admin/catalog/packages)
--   agent_registry_gemini     Google Gemini Enterprise agents (Discovery Engine v1alpha assistants/*/agents)
--   agent_registry_agentcore  AWS Bedrock AgentCore runtimes (bedrock-agentcore-control ListAgentRuntimes)
--
-- 1. `discovery_settings.agent_registry_sources_enabled`, default false. Turning it on is a `settings_relax` step-up;
--    turning it off is free and stops every run of the family (the routes and the worker refuse it while it is off).
-- 2. The kind CHECKs of `discovery_sources` and `discovery_runs` are widened with the three kinds.
-- 3. `agent_registry_records`: what the registries listed, staged per source until an admin imports a record into
--    `agents` (step-up, audited). An imported agent starts disabled, lifecycle `proposed`, with no grant of any kind.
--    Single-tenant deployment tables carry no RLS policy (ADR-0234 covers users, auth_mfa_pending, approvals and
--    audit_log); every route that reads or writes this table is admin-only.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "agent_registry_sources_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_sources" DROP CONSTRAINT IF EXISTS "discovery_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore'));
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT IF EXISTS "discovery_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_registry_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "registry" text NOT NULL,
  "external_id" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  -- 3NF exception, deliberate: a bounded, verbatim subset of the vendor's own record, kept as evidence; never joined on
  "vendor_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "absent_since" timestamp with time zone,
  "last_run_id" uuid REFERENCES "discovery_runs"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "imported_at" timestamp with time zone,
  "imported_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "agent_registry_records_registry_check"
    CHECK ("registry" IN ('entra_agent_id', 'agent_365', 'gemini_enterprise', 'bedrock_agentcore')),
  CONSTRAINT "agent_registry_records_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 2048),
  CONSTRAINT "agent_registry_records_display_name_check" CHECK (char_length("display_name") BETWEEN 1 AND 256),
  CONSTRAINT "agent_registry_records_description_check" CHECK ("description" IS NULL OR char_length("description") <= 1000),
  CONSTRAINT "agent_registry_records_attributes_check"
    CHECK (jsonb_typeof("vendor_attributes") = 'object' AND pg_column_size("vendor_attributes") <= 8192),
  CONSTRAINT "agent_registry_records_imported_check" CHECK ("agent_id" IS NULL OR "imported_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_registry_records_vendor_uq" ON "agent_registry_records" ("source_id", "registry", "external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_registry_records_agent_uq" ON "agent_registry_records" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_registry_records_open_idx" ON "agent_registry_records" ("last_seen_at") WHERE "agent_id" IS NULL;
