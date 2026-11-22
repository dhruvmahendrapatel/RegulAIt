-- ADR-0336 (lane E17, slice 4): plaintext credentials found in a staged agent's configuration are raised as discovery
-- findings through the existing observation path, under the new evidence kind `agent_config`. Pending migration
-- (ADR-0252): numbered at merge. Hand-authored (never drizzle-kit generate). Re-runnable: the statement pair is
-- idempotent. Nothing is backfilled (ADR-0180). No new table: `shadow_ai_findings.subject_kind` already allows
-- `system`, and a finding keeps only the field path and the vendored rule id (never the value).
--
-- `shadow_ai_imports.kind` gains `agent_config`. The list is the full set from 0318_third_party_ingest.sql plus it.

ALTER TABLE "shadow_ai_imports" DROP CONSTRAINT IF EXISTS "shadow_ai_imports_kind_ck";
--> statement-breakpoint
ALTER TABLE "shadow_ai_imports" ADD CONSTRAINT "shadow_ai_imports_kind_ck" CHECK ("kind" IN (
  'egress_log', 'code_scan', 'saas_export', 'self_reported',
  'repo_scan', 'cloud_inventory', 'cloud_audit_log', 'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory', 'idp_app_grant', 'ml_platform_inventory',
  'defenseclaw_export',
  'agent_config'));
