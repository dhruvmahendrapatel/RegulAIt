-- ADR-0336 (lane E17, slice 1): agent platform discovery, starting with Copilot Studio, and the components of a
-- staged registry agent. Pending migration (ADR-0252): numbered at merge. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. Nothing is backfilled and no existing row changes (ADR-0180).
-- NAMED TO SORT LAST: pending files are applied and numbered in byte order of their names, and this file must follow
-- `agent_registry_records.sql` (its parent table) and `saas_entitlement_graph.sql` (which re-creates the same kind
-- CHECKs without `agent_registry_copilot_studio`).
--
-- 1. The kind CHECKs of `discovery_sources` and `discovery_runs` gain `agent_registry_copilot_studio` (family
--    `agent_registry`, still behind its org switch, off by default). The lists are the full kind set, so this file is
--    correct whichever pending file is numbered first.
-- 2. `agent_registry_records_registry_check` gains `copilot_studio`.
-- 3. `agent_registry_record_components`: one row per (record, kind, vendor reference), the models, tools, MCP
--    servers, connected apps and knowledge sources a staged agent uses. Third normal form: a list is a table. A
--    connected app is a connector reference, never credential material; no instruction or prompt text is stored
--    (ADR-0336 decision 4). Deleting a record (or its source) deletes its components (ON DELETE CASCADE; referential
--    actions bypass row-level security by design).
--    Row-level security is enabled and FORCED: an admin, the discovery worker (`system_task`) and migrations only.

ALTER TABLE "discovery_sources" DROP CONSTRAINT IF EXISTS "discovery_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore', 'agent_registry_copilot_studio'));
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT IF EXISTS "discovery_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore', 'agent_registry_copilot_studio'));
--> statement-breakpoint
ALTER TABLE "agent_registry_records" DROP CONSTRAINT IF EXISTS "agent_registry_records_registry_check";
--> statement-breakpoint
ALTER TABLE "agent_registry_records" ADD CONSTRAINT "agent_registry_records_registry_check"
  CHECK ("registry" IN ('entra_agent_id', 'agent_365', 'gemini_enterprise', 'bedrock_agentcore', 'copilot_studio'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_registry_record_components" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "record_id" uuid NOT NULL REFERENCES "agent_registry_records"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "vendor_ref" text NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean,
  "provided_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_registry_record_components_kind_check"
    CHECK ("kind" IN ('model', 'tool', 'mcp_server', 'connected_app', 'knowledge')),
  CONSTRAINT "agent_registry_record_components_provided_by_check"
    CHECK ("provided_by" IS NULL OR "provided_by" IN ('maker', 'end_user')),
  CONSTRAINT "agent_registry_record_components_vendor_ref_check" CHECK (char_length("vendor_ref") BETWEEN 1 AND 512),
  CONSTRAINT "agent_registry_record_components_display_name_check" CHECK (char_length("display_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_registry_record_components_uq" ON "agent_registry_record_components" ("record_id", "kind", "vendor_ref");
--> statement-breakpoint
ALTER TABLE "agent_registry_record_components" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_registry_record_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_registry_record_components_admin" ON "agent_registry_record_components";
--> statement-breakpoint
CREATE POLICY "agent_registry_record_components_admin" ON "agent_registry_record_components" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
