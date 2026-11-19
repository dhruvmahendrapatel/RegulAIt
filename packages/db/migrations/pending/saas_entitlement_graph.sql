-- ADR-0337 (lane E18): the SaaS entitlement graph. Hand-authored (never drizzle-kit generate); additive and idempotent.
--
-- 1. Four read-only discovery source kinds join the ADR-0195 framework in the `identity` family (behind its existing
--    default-off org switch; each source is also off until an admin enables it):
--      entitlement_m365               app permissions and consents in Microsoft 365 (Microsoft Graph)
--      entitlement_google_workspace   OAuth app grants in Google Workspace (Admin SDK Reports, read-only scope)
--      entitlement_salesforce         connected app permissions (reader built in a later slice)
--      entitlement_slack              app scopes (reader built in a later slice)
--    The kind CHECKs of `discovery_sources` and `discovery_runs` are widened with them. Nothing is backfilled.
-- 2. Four tables in third normal form hold what an entitlement read returns:
--      saas_entitlement_apps              one app (an Entra service principal, a Google OAuth client, ...) per source
--      saas_entitlement_scopes            the scope dictionary: one row per (platform, resource, scope name)
--      saas_entitlement_grants            app x scope x grant type (join table), with its consent breadth
--      saas_entitlement_grant_principals  grant x pseudonymised user (join table) for user consents
--    A person is only ever a `discovery_pseudonyms` row (ADR-0195 decision 20); no name or email is stored here. The
--    platform is not stored on an app: it is the source's kind. A scope's access class is computed from its name by
--    the frozen classifier (`@regulait/shared` saas-entitlements), never stored.
--
-- Row-level security, ENABLED and FORCED on every new table: an active admin principal (regulait_rls_is_admin(), which
-- also admits the bootstrap token) and the `system_task` and `migration` reasons only (the discovery worker runs as a
-- scheduler job under `system_task`). Deleting a source or a pseudonym cascades by design (PostgreSQL referential
-- actions bypass row-level security). No functions or triggers.

ALTER TABLE "discovery_sources" DROP CONSTRAINT IF EXISTS "discovery_sources_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore'));
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT IF EXISTS "discovery_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
  'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
  'cloud_aws', 'cloud_gcp', 'cloud_azure',
  'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent',
  'saas_inventory_api', 'idp_entra', 'ml_mlflow',
  'entitlement_m365', 'entitlement_google_workspace', 'entitlement_salesforce', 'entitlement_slack',
  'agent_registry_entra', 'agent_registry_gemini', 'agent_registry_agentcore'));
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "google_directory_tokens_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saas_entitlement_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "app_kind" text NOT NULL,
  "display_name" text,
  "publisher" text,
  "publisher_verified" boolean,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE RESTRICT,
  "agent_link_state" text DEFAULT 'none' NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "last_seen_run_id" uuid REFERENCES "discovery_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "saas_entitlement_apps_uq" UNIQUE ("source_id", "external_id"),
  CONSTRAINT "saas_entitlement_apps_kind_check"
    CHECK ("app_kind" IN ('service_principal', 'oauth_client', 'connected_app', 'slack_app')),
  CONSTRAINT "saas_entitlement_apps_external_id_check" CHECK (length("external_id") BETWEEN 1 AND 255),
  CONSTRAINT "saas_entitlement_apps_display_name_check" CHECK ("display_name" IS NULL OR length("display_name") BETWEEN 1 AND 200),
  CONSTRAINT "saas_entitlement_apps_publisher_check" CHECK ("publisher" IS NULL OR length("publisher") BETWEEN 1 AND 200),
  CONSTRAINT "saas_entitlement_apps_seen_check" CHECK ("first_seen_at" <= "last_seen_at"),
  CONSTRAINT "saas_entitlement_apps_agent_link_state_check" CHECK ("agent_link_state" IN ('none', 'auto', 'admin', 'unlinked')),
  CONSTRAINT "saas_entitlement_apps_agent_link_pair_check"
    CHECK (("agent_id" IS NOT NULL) = ("agent_link_state" = 'auto' OR "agent_link_state" = 'admin'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_entitlement_apps_agent_idx" ON "saas_entitlement_apps" ("agent_id") WHERE "agent_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_vendor_identifiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE RESTRICT,
  "platform" text NOT NULL,
  "external_id" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_vendor_identifiers_uq" UNIQUE ("platform", "external_id"),
  CONSTRAINT "agent_vendor_identifiers_platform_check" CHECK ("platform" IN ('m365', 'google_workspace', 'salesforce', 'slack')),
  CONSTRAINT "agent_vendor_identifiers_external_id_check" CHECK ("external_id" ~ '^[!-~]{1,255}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_vendor_identifiers_agent_idx" ON "agent_vendor_identifiers" ("agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saas_entitlement_scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform" text NOT NULL,
  "resource" text DEFAULT '' NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "saas_entitlement_scopes_uq" UNIQUE ("platform", "resource", "name"),
  CONSTRAINT "saas_entitlement_scopes_platform_check" CHECK ("platform" IN ('m365', 'google_workspace', 'salesforce', 'slack')),
  CONSTRAINT "saas_entitlement_scopes_resource_check" CHECK (length("resource") <= 255),
  CONSTRAINT "saas_entitlement_scopes_name_check" CHECK (length("name") BETWEEN 1 AND 512)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saas_entitlement_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "app_id" uuid NOT NULL REFERENCES "saas_entitlement_apps"("id") ON DELETE CASCADE,
  "scope_id" uuid NOT NULL REFERENCES "saas_entitlement_scopes"("id") ON DELETE RESTRICT,
  "grant_type" text NOT NULL,
  "consent" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "last_seen_run_id" uuid REFERENCES "discovery_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "saas_entitlement_grants_uq" UNIQUE ("app_id", "scope_id", "grant_type"),
  CONSTRAINT "saas_entitlement_grants_type_check" CHECK ("grant_type" IN ('delegated', 'application')),
  CONSTRAINT "saas_entitlement_grants_consent_check" CHECK ("consent" IN ('tenant', 'user')),
  CONSTRAINT "saas_entitlement_grants_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_entitlement_grants_scope_idx" ON "saas_entitlement_grants" ("scope_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saas_entitlement_grant_principals" (
  "grant_id" uuid NOT NULL REFERENCES "saas_entitlement_grants"("id") ON DELETE CASCADE,
  "pseudonym_id" uuid NOT NULL REFERENCES "discovery_pseudonyms"("id") ON DELETE CASCADE,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "saas_entitlement_grant_principals_pk" PRIMARY KEY ("grant_id", "pseudonym_id"),
  CONSTRAINT "saas_entitlement_grant_principals_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saas_entitlement_grant_principals_pseudonym_idx" ON "saas_entitlement_grant_principals" ("pseudonym_id");
--> statement-breakpoint
ALTER TABLE "saas_entitlement_apps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_apps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_apps_admin" ON "saas_entitlement_apps";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_apps_admin" ON "saas_entitlement_apps" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "saas_entitlement_scopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_scopes_admin" ON "saas_entitlement_scopes";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_scopes_admin" ON "saas_entitlement_scopes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "saas_entitlement_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_grants_admin" ON "saas_entitlement_grants";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_grants_admin" ON "saas_entitlement_grants" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "saas_entitlement_grant_principals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_grant_principals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_grant_principals_admin" ON "saas_entitlement_grant_principals";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_grant_principals_admin" ON "saas_entitlement_grant_principals" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "agent_vendor_identifiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_vendor_identifiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_vendor_identifiers_admin" ON "agent_vendor_identifiers";
--> statement-breakpoint
CREATE POLICY "agent_vendor_identifiers_admin" ON "agent_vendor_identifiers" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
