-- ADR-0332 (lane E14): the endpoint AI add-on inventory read model.
--
-- Four tables in third normal form: an endpoint (its ADR-0195 pseudonym, joined to an enrolled device when there is
-- one), an add-on (kind + identity), a version of it (reported version string + content digest, if any) and a
-- sighting joining one version to one endpoint for one detection source. A sighting projected from discovery
-- evidence references that evidence row and is deleted with it, so the read model never outlives the endpoint
-- retention. The admission-scan verdict is not stored: the gateway joins `admission_engine_scans` by digest at read.
--
-- Row-level security, ENABLED and FORCED on every table: an active admin principal (regulait_rls_is_admin(), which
-- also admits the bootstrap token) and the `system_task` and `migration` reasons only. No other principal and no
-- request reason (credential_request, public_ingest) reads or writes a row. Foreign-key cascades from the evidence
-- tables bypass row-level security by design (PostgreSQL referential actions), so retention still deletes here.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "endpoint_addon_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pseudonym" text NOT NULL,
  "device_id" uuid REFERENCES "endpoint_devices"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_addon_endpoints_pseudonym_uq" UNIQUE ("pseudonym"),
  CONSTRAINT "endpoint_addon_endpoints_pseudonym_check" CHECK ("pseudonym" ~ '^psn:[0-9a-f]{24}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_addon_endpoints_device_uq"
  ON "endpoint_addon_endpoints" ("device_id") WHERE "device_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "identity_kind" text NOT NULL,
  "identity" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_addons_identity_uq" UNIQUE ("kind", "identity_kind", "identity"),
  CONSTRAINT "endpoint_addons_kind_check" CHECK ("kind" IN ('coding_agent', 'mcp_server', 'skill', 'plugin')),
  CONSTRAINT "endpoint_addons_identity_kind_check"
    CHECK ("identity_kind" IN ('provider', 'package', 'host', 'command', 'name', 'unknown')),
  CONSTRAINT "endpoint_addons_identity_check" CHECK (length("identity") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "addon_id" uuid NOT NULL REFERENCES "endpoint_addons"("id") ON DELETE CASCADE,
  "version" text DEFAULT '' NOT NULL,
  "content_digest" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_addon_versions_uq" UNIQUE NULLS NOT DISTINCT ("addon_id", "version", "content_digest"),
  CONSTRAINT "endpoint_addon_versions_digest_check" CHECK ("content_digest" IS NULL OR "content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_addon_versions_version_check" CHECK (length("version") <= 128)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_versions_digest_idx"
  ON "endpoint_addon_versions" ("content_digest") WHERE "content_digest" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_sightings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version_id" uuid NOT NULL REFERENCES "endpoint_addon_versions"("id") ON DELETE CASCADE,
  "endpoint_id" uuid NOT NULL REFERENCES "endpoint_addon_endpoints"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "host_agent" text DEFAULT '' NOT NULL,
  "endpoint_mcp_server_id" uuid REFERENCES "endpoint_mcp_servers"("id") ON DELETE CASCADE,
  "shadow_ai_finding_id" uuid REFERENCES "shadow_ai_findings"("id") ON DELETE CASCADE,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "endpoint_addon_sightings_source_check"
    CHECK ("source" IN ('endpoint_agent', 'endpoint_osquery', 'endpoint_inventory')),
  CONSTRAINT "endpoint_addon_sightings_evidence_check" CHECK ("endpoint_mcp_server_id" IS NULL OR "shadow_ai_finding_id" IS NULL),
  CONSTRAINT "endpoint_addon_sightings_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_addon_sightings_mcp_uq"
  ON "endpoint_addon_sightings" ("endpoint_mcp_server_id") WHERE "endpoint_mcp_server_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_addon_sightings_finding_uq"
  ON "endpoint_addon_sightings" ("shadow_ai_finding_id") WHERE "shadow_ai_finding_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_addon_sightings_direct_uq"
  ON "endpoint_addon_sightings" ("version_id", "endpoint_id", "source", "host_agent")
  WHERE "endpoint_mcp_server_id" IS NULL AND "shadow_ai_finding_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_sightings_version_idx" ON "endpoint_addon_sightings" ("version_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_sightings_endpoint_idx" ON "endpoint_addon_sightings" ("endpoint_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_sighting_secret_types" (
  "sighting_id" uuid NOT NULL REFERENCES "endpoint_addon_sightings"("id") ON DELETE CASCADE,
  "secret_type" text NOT NULL,
  CONSTRAINT "endpoint_addon_sighting_secret_types_pk" PRIMARY KEY ("sighting_id", "secret_type"),
  CONSTRAINT "endpoint_addon_sighting_secret_types_check" CHECK ("secret_type" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "endpoint_addon_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_endpoints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_endpoints_admin" ON "endpoint_addon_endpoints";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_endpoints_admin" ON "endpoint_addon_endpoints" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addons" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addons_admin" ON "endpoint_addons";
--> statement-breakpoint
CREATE POLICY "endpoint_addons_admin" ON "endpoint_addons" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addon_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_versions_admin" ON "endpoint_addon_versions";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_versions_admin" ON "endpoint_addon_versions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addon_sightings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_sightings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_sightings_admin" ON "endpoint_addon_sightings";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_sightings_admin" ON "endpoint_addon_sightings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addon_sighting_secret_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_sighting_secret_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_sighting_secret_types_admin" ON "endpoint_addon_sighting_secret_types";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_sighting_secret_types_admin" ON "endpoint_addon_sighting_secret_types" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
