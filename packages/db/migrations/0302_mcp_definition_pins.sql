-- ADR-0246: MCP definition pinning (rug-pull detection).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `org_settings.mcp_definition_pin_mode`, default 'block' (ADR-0180): a tool, prompt or resource that changed
--    since approval is refused until an admin re-approves it. 'warn' only audits; relaxing to it is a settings_relax
--    step-up, audited by `PUT /v1/org/settings`.
-- 2. `mcp_servers.definitions_pinned_at`: when the admission baseline was taken. No backfill (the product is not
--    live): every existing server is baselined at its next admitted manifest, exactly as a new one is.
-- 3. `mcp_definition_pins`: one row per tool, prompt, resource or resource template, with the approved and the
--    observed digest and definition. Status is derived from the two digests, never stored. The definitions are
--    point-in-time evidence (the ADR-0200 normalisation exception) for the admin diff.
-- No functions or triggers. Not a tenant table: like `mcp_servers` it is deployment configuration read by the
-- admin-only API, so it is outside the ADR-0234 row-level-security slices.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "mcp_definition_pin_mode" text DEFAULT 'block' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_mcp_definition_pin_mode_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_mcp_definition_pin_mode_check"
  CHECK ("mcp_definition_pin_mode" IN ('block', 'warn'));
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "definitions_pinned_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_definition_pins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "approved_digest" text,
  "approved_definition" jsonb,
  "approved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at" timestamp with time zone,
  "observed_digest" text,
  "observed_definition" jsonb,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_at" timestamp with time zone,
  CONSTRAINT "mcp_definition_pins_kind_check" CHECK ("kind" IN ('tool', 'prompt', 'resource', 'resource_template')),
  CONSTRAINT "mcp_definition_pins_some_digest" CHECK ("approved_digest" IS NOT NULL OR "observed_digest" IS NOT NULL),
  CONSTRAINT "mcp_definition_pins_approved_pair" CHECK (("approved_digest" IS NULL) = ("approved_definition" IS NULL)),
  CONSTRAINT "mcp_definition_pins_observed_pair" CHECK (("observed_digest" IS NULL) = ("observed_definition" IS NULL))
);
--> statement-breakpoint
COMMENT ON COLUMN "mcp_definition_pins"."approved_definition" IS
  'ADR-0200 exception: point-in-time evidence, the exact definition that was approved, kept for the admin diff';
--> statement-breakpoint
COMMENT ON COLUMN "mcp_definition_pins"."observed_definition" IS
  'ADR-0200 exception: point-in-time evidence, the definition as last served, kept for the admin diff';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_definition_pins_server_kind_name_uq"
  ON "mcp_definition_pins" ("server_id", "kind", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_definition_pins_drift_idx"
  ON "mcp_definition_pins" ("server_id")
  WHERE "approved_digest" IS DISTINCT FROM "observed_digest";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_definition_pins_approved_by_idx" ON "mcp_definition_pins" ("approved_by");
