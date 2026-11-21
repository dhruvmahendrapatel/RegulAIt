-- ADR-0336 (lane E17, slice 3): OpenAI custom GPT and n8n workflow discovery. Pending migration (ADR-0252): numbered
-- at merge. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Nothing is
-- backfilled (ADR-0180).
-- NAMED TO SORT LAST: pending files are applied and numbered in byte order, and this file must follow
-- `agent_registry_records.sql`, `saas_entitlement_graph.sql`, `vendor_agent_platform_components.sql` and
-- `vendor_agent_platform_components_agentforce.sql`, which re-create the same CHECKs. The lists are the full sets.
--
-- 1. The kind CHECKs of `discovery_sources` and `discovery_runs` gain `agent_registry_openai` and `agent_registry_n8n`.
-- 2. `agent_registry_records_registry_check` gains `openai_gpts` and `n8n`.

ALTER TABLE "discovery_sources" DROP CONSTRAINT IF EXISTS "discovery_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore', 'agent_registry_copilot_studio',
  'agent_registry_agentforce', 'agent_registry_openai', 'agent_registry_n8n'));
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT IF EXISTS "discovery_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore', 'agent_registry_copilot_studio',
  'agent_registry_agentforce', 'agent_registry_openai', 'agent_registry_n8n'));
--> statement-breakpoint
ALTER TABLE "agent_registry_records" DROP CONSTRAINT IF EXISTS "agent_registry_records_registry_check";
--> statement-breakpoint
ALTER TABLE "agent_registry_records" ADD CONSTRAINT "agent_registry_records_registry_check"
  CHECK ("registry" IN ('entra_agent_id', 'agent_365', 'gemini_enterprise', 'bedrock_agentcore', 'copilot_studio', 'agentforce', 'openai_gpts', 'n8n'));
