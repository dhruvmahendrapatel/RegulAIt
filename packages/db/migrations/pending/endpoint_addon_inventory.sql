-- ADR-0332 (lane E14): the endpoint AI add-on inventory: the direct-record tables.
--
-- The inventory is read, not projected: MCP servers (endpoint_mcp_servers, ADR-0259) and coding agents (device
-- shadow_ai_findings, ADR-0195) are joined at read time. These four tables, in third normal form, hold only what the
-- evidence tables do not: a sighting an endpoint lane records directly (a skill or plugin with its content digest).
-- An add-on (kind + identity), a version (version string + content digest), a sighting (one version on one enrolled
-- device for one source and host agent; the pseudonym is joined from endpoint_devices) and its secret TYPES.
--
-- Row-level security, ENABLED and FORCED on every table: an active admin principal (regulait_rls_is_admin(), which
-- also admits the bootstrap token) and the `system_task` and `migration` reasons only. No other principal and no
-- request reason (credential_request, public_ingest) reads or writes a row. The device cascade bypasses row-level
-- security by design (PostgreSQL referential actions), so a deleted device takes its sightings with it.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
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
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "host_agent" text DEFAULT '' NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "endpoint_addon_sightings_uq" UNIQUE ("version_id", "device_id", "source", "host_agent"),
  CONSTRAINT "endpoint_addon_sightings_source_check"
    CHECK ("source" IN ('endpoint_agent', 'endpoint_osquery', 'endpoint_inventory')),
  CONSTRAINT "endpoint_addon_sightings_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_sightings_device_idx" ON "endpoint_addon_sightings" ("device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_sightings_last_seen_idx" ON "endpoint_addon_sightings" ("last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_sighting_secret_types" (
  "sighting_id" uuid NOT NULL REFERENCES "endpoint_addon_sightings"("id") ON DELETE CASCADE,
  "secret_type" text NOT NULL,
  CONSTRAINT "endpoint_addon_sighting_secret_types_pk" PRIMARY KEY ("sighting_id", "secret_type"),
  CONSTRAINT "endpoint_addon_sighting_secret_types_check" CHECK ("secret_type" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
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
