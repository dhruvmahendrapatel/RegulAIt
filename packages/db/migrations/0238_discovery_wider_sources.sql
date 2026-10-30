-- Migration 0238. ADR-0218 (P9): wider shadow-AI discovery sources. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent.
--
-- Adds three read-only source kinds to the ADR-0195 discovery framework, each in a new family behind its own org
-- switch, all OFF (ADR-0180 first-load posture; nothing is backfilled, no existing row changes):
--
--   saas_inventory_api   a SaaS app inventory read over a customer-named JSON API          family saas
--   idp_entra            OAuth/OIDC app consents held by a Microsoft Entra ID tenant      family identity
--   ml_mlflow            registered models and serving endpoints of an MLflow-compatible  family ml_platform
--                        ML platform outside the three clouds
--
-- 1. `discovery_settings.saas_sources_enabled`, `identity_sources_enabled`, `ml_platform_sources_enabled`: the
--    family switches, default false. Turning one on is a `settings_relax` step-up; turning one off is free and
--    stops every run of that family (the routes and the worker refuse it while it is off).
-- 2. The kind CHECKs of `discovery_sources` and `discovery_runs` are widened with the three kinds.
-- 3. `shadow_ai_imports.kind` gains the evidence kinds `saas_inventory`, `idp_app_grant`, `ml_platform_inventory`.
-- 4. `ai_endpoint_signatures.kind` gains the identifier kinds `oauth_app` (an identity provider's client
--    application id) and `ml_platform_asset` (an ML platform asset key); both match by `identifier` only.
-- 5. `discovery_pseudonyms.kind` gains `idp_user`: the user behind a delegated consent, kept only as a pseudonym.
--
-- No new table, so no new RLS policy or grant; every widened table keeps the policies and guards it has.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "saas_sources_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "identity_sources_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "ml_platform_sources_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_sources" DROP CONSTRAINT IF EXISTS "discovery_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow'));
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT IF EXISTS "discovery_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow'));
--> statement-breakpoint
ALTER TABLE "shadow_ai_imports" DROP CONSTRAINT IF EXISTS "shadow_ai_imports_kind_ck";
--> statement-breakpoint
ALTER TABLE "shadow_ai_imports" ADD CONSTRAINT "shadow_ai_imports_kind_ck" CHECK ("kind" IN (
  'egress_log', 'code_scan', 'saas_export', 'self_reported',
  'repo_scan', 'cloud_inventory', 'cloud_audit_log', 'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory', 'idp_app_grant', 'ml_platform_inventory'));
--> statement-breakpoint
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_ck";
--> statement-breakpoint
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_ck" CHECK ("kind" IN (
  'hostname', 'sdk_package', 'api_key_prefix', 'web_app',
  'cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime', 'assistant_config',
  'oauth_app', 'ml_platform_asset'));
--> statement-breakpoint
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_match_ck";
--> statement-breakpoint
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_match_ck" CHECK (
  ("kind" = 'sdk_package') = ("match_type" = 'package')
  AND ("kind" = 'api_key_prefix') = ("match_type" = 'key_prefix')
  AND ("kind" IN ('cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime',
                  'assistant_config', 'oauth_app', 'ml_platform_asset')) = ("match_type" = 'identifier')
);
--> statement-breakpoint
ALTER TABLE "discovery_pseudonyms" DROP CONSTRAINT IF EXISTS "discovery_pseudonyms_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_pseudonyms" ADD CONSTRAINT "discovery_pseudonyms_kind_check"
  CHECK ("kind" IN ('device_user', 'commit_author', 'cloud_principal', 'device', 'idp_user'));
