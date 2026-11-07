-- ADR-0236 (backlog P11): governed MCP bundles. Hand-authored (never drizzle-kit generate). Re-runnable: every
-- statement is idempotent.
--
-- 1. `org_settings.mcp_bundles_enabled`, default false (ADR-0180). While false no bundle can be created, changed or
--    granted, and the gateway loads no bundle grant at all, so every decision is what it was before 0298. Turning it on
--    goes through the audited `PUT /v1/org/settings` and is a `settings_relax` step-up (strictness registry).
-- 2. `mcp_bundles`: a named bundle. `current_version` points at the version every grant follows. `archived_at` set =
--    the bundle grants nothing (its history stays).
-- 3. `mcp_bundle_versions` and `mcp_bundle_version_items`: one immutable version per change, listing exact
--    (server, tool) pairs. No wildcard: a tool a server adds later is in no bundle until a new version names it.
--    Both tables are append-only (regulait_refuse_mutation + no TRUNCATE); a version is a point-in-time snapshot.
-- 4. `mcp_bundle_grants`: who holds a bundle - exactly one of a user, a role or a team. No row = nothing granted.
--    `max_tier` caps the tools the grant reaches: read < write < dangerous. Default 'read' (ADR-0180): a grant reaches
--    a bundle's write tools only when the admin says so.
-- 5. Scope tiers (design reference: the read/write/dangerous scopes of the Gravitee APIM MCP server; ideas only, no
--    code): `mcp_tools.dangerous` is an admin flag, default false. A dangerous tool held through a bundle always pauses
--    for `mcp_bundles.approver_user_id`; with no approver it is refused (fail closed).
-- Every change to 2-4 advances the governance policy epoch, so a decision taken before a bundle change is re-checked.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "mcp_bundles_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN IF NOT EXISTS "dangerous" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "current_version" integer DEFAULT 1 NOT NULL,
  "archived_at" timestamp with time zone,
  "approver_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_bundles_name_uq" UNIQUE ("name"),
  CONSTRAINT "mcp_bundles_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT "mcp_bundles_description_check" CHECK ("description" IS NULL OR char_length("description") <= 1000),
  CONSTRAINT "mcp_bundles_current_version_check" CHECK ("current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_bundle_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_id" uuid NOT NULL REFERENCES "mcp_bundles"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_bundle_versions_bundle_version_uq" UNIQUE ("bundle_id", "version"),
  CONSTRAINT "mcp_bundle_versions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
-- server_id is ON DELETE SET NULL (nullable): the version is a point-in-time snapshot that outlives a removed server;
-- a NULL server matches no call. tool_name is the name the policy kernel matches on, as in role_tool_grants.
CREATE TABLE IF NOT EXISTS "mcp_bundle_version_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version_id" uuid NOT NULL REFERENCES "mcp_bundle_versions"("id") ON DELETE CASCADE,
  "server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE SET NULL,
  "tool_name" text NOT NULL,
  CONSTRAINT "mcp_bundle_version_items_tool_check" CHECK (char_length("tool_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_bundle_version_items_uq" ON "mcp_bundle_version_items" ("version_id", "server_id", "tool_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_bundle_version_items_server_idx" ON "mcp_bundle_version_items" ("server_id", "version_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_bundle_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bundle_id" uuid NOT NULL REFERENCES "mcp_bundles"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid REFERENCES "roles"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "max_tier" text DEFAULT 'read' NOT NULL,
  "granted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_bundle_grants_max_tier_check" CHECK ("max_tier" IN ('read', 'write', 'dangerous')),
  CONSTRAINT "mcp_bundle_grants_one_subject_check" CHECK (num_nonnulls("user_id", "role_id", "team_id") = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_bundle_grants_user_uq" ON "mcp_bundle_grants" ("bundle_id", "user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_bundle_grants_role_uq" ON "mcp_bundle_grants" ("bundle_id", "role_id") WHERE "role_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_bundle_grants_team_uq" ON "mcp_bundle_grants" ("bundle_id", "team_id") WHERE "team_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_bundle_grants_user_idx" ON "mcp_bundle_grants" ("user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_bundle_grants_role_idx" ON "mcp_bundle_grants" ("role_id") WHERE "role_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_bundle_grants_team_idx" ON "mcp_bundle_grants" ("team_id") WHERE "team_id" IS NOT NULL;
--> statement-breakpoint
-- versions and their items are evidence of what a bundle granted when: append-only. The two-argument form lets the
-- cascade of the row's OWN parent through (a test fixture deleting its bundle); the SET NULL of a removed server or
-- user is let through by regulait_refuse_mutation's own rule.
DROP TRIGGER IF EXISTS "mcp_bundle_versions_append_only" ON "mcp_bundle_versions";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_versions_append_only" BEFORE UPDATE OR DELETE ON "mcp_bundle_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('bundle_id', 'mcp_bundles');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundle_versions_no_truncate" ON public."mcp_bundle_versions";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_versions_no_truncate" BEFORE TRUNCATE ON public."mcp_bundle_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundle_version_items_append_only" ON "mcp_bundle_version_items";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_version_items_append_only" BEFORE UPDATE OR DELETE ON "mcp_bundle_version_items"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('version_id', 'mcp_bundle_versions');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundle_version_items_no_truncate" ON public."mcp_bundle_version_items";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_version_items_no_truncate" BEFORE TRUNCATE ON public."mcp_bundle_version_items"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundles_policy_epoch" ON "mcp_bundles";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundles_policy_epoch" AFTER INSERT OR UPDATE OR DELETE ON "mcp_bundles"
  FOR EACH STATEMENT EXECUTE FUNCTION advance_governance_policy_epoch();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundle_versions_policy_epoch" ON "mcp_bundle_versions";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_versions_policy_epoch" AFTER INSERT ON "mcp_bundle_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION advance_governance_policy_epoch();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_bundle_grants_policy_epoch" ON "mcp_bundle_grants";
--> statement-breakpoint
CREATE TRIGGER "mcp_bundle_grants_policy_epoch" AFTER INSERT OR UPDATE OR DELETE ON "mcp_bundle_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION advance_governance_policy_epoch();
