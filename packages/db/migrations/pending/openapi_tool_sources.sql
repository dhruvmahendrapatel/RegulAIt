-- ADR-0353 part 1 — governed MCP tools from an OpenAPI document or a REST endpoint list. Hand-authored (never
-- drizzle-kit generate).
--
-- 1. `mcp_servers` gains the `openapi` transport: an in-process upstream whose url is the `openapi:<name>` sentinel
--    (like `stdio:<name>`, never a destination). `mcp_servers_openapi_shape` ties the transport to the sentinel both
--    ways, so no other row can carry it and no openapi row can carry a real URL.
-- 2. The org's upstream transport list may now name `openapi`. Its DEFAULT is unchanged (`["streamable_http"]`), so
--    the transport is off until an admin enables it (ADR-0180); no existing row is touched.
-- 3. `openapi_tool_sources` (one per imported document) and `openapi_tool_operations` (one per generated tool). The
--    operation state is the declared lifecycle (OPENAPI_OPERATION_TRANSITIONS); its checks tie `approved` to an
--    approved digest equal to the imported one and `drifted` to a different one, so a row written around the API
--    cannot serve a definition nobody approved. The two definition columns are point-in-time snapshots (the ADR-0200
--    exception, as ADR-0246's pins).
-- 4. No row-level security, like `mcp_servers` and `mcp_tools`: these are deployment-wide MCP configuration, not
--    tenant data, and the MCP proxy reads them on every caller's behalf. Writes go only through the admin routes.
-- 5. No new function or trigger, so the 0185 guard (search_path pinning, TRUNCATE refusal) has nothing to check here.

ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_transport_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_check" CHECK ("transport" IN ('streamable_http', 'sse', 'stdio', 'openapi'));
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_openapi_shape";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_openapi_shape" CHECK (("transport" = 'openapi') = ("url" LIKE 'openapi:%'));
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_mcp_upstream_transports_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_mcp_upstream_transports_check" CHECK (
  jsonb_typeof("mcp_upstream_transports") = 'array'
  AND "mcp_upstream_transports" <@ '["streamable_http", "sse", "stdio", "openapi"]'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "openapi_tool_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mcp_server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "base_url" text NOT NULL,
  "source_kind" text NOT NULL,
  "spec_title" text,
  "spec_version" text,
  "spec_digest" text NOT NULL,
  "imported_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "imported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "openapi_tool_sources_kind_check" CHECK ("source_kind" IN ('openapi', 'rest_endpoints')),
  CONSTRAINT "openapi_tool_sources_digest_check" CHECK ("spec_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "openapi_tool_sources_base_url_check" CHECK ("base_url" ~ '^https?://' AND char_length("base_url") <= 2048)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "openapi_tool_sources_server_uq" ON "openapi_tool_sources" ("mcp_server_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "openapi_tool_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "openapi_tool_sources"("id") ON DELETE CASCADE,
  "operation_key" text NOT NULL,
  "tool_name" text NOT NULL,
  "state" text DEFAULT 'staged' NOT NULL,
  "imported_definition" jsonb NOT NULL,
  "imported_digest" text NOT NULL,
  "approved_definition" jsonb,
  "approved_digest" text,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "openapi_tool_operations_state_check" CHECK ("state" IN ('staged', 'approved', 'drifted', 'rejected', 'withdrawn')),
  CONSTRAINT "openapi_tool_operations_digest_check" CHECK ("imported_digest" ~ '^[0-9a-f]{64}$' AND ("approved_digest" IS NULL OR "approved_digest" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "openapi_tool_operations_tool_name_check" CHECK ("tool_name" ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT "openapi_tool_operations_approval_check" CHECK (
    ("approved_digest" IS NULL) = ("approved_definition" IS NULL)
    AND ("state" <> 'approved' OR "approved_digest" = "imported_digest")
    AND ("state" <> 'drifted' OR ("approved_digest" IS NOT NULL AND "approved_digest" <> "imported_digest"))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "openapi_tool_operations_key_uq" ON "openapi_tool_operations" ("source_id", "operation_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "openapi_tool_operations_served_name_uq" ON "openapi_tool_operations" ("source_id", "tool_name") WHERE "state" = 'approved';
