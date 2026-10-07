-- ADR-0185 (batch 3) — memory retention, MCP protocol coverage and transports,
-- ownership, the Outlook recipient allow-list.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785104000000
-- (previous + 1,000,000, CONTRIBUTING_PARALLEL_SESSIONS §4.1).
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180): every new column defaults to
-- its strict value and the existing rows take it, as on a first load.
--
-- 1. `org_settings`
--    - `conversation_retention_days` 30 (owner decision 2026-10-07), 1–2555; a
--      longer value is an audited relaxation (I3).
--    - `semantic_cache_ttl_seconds` gains the CHECK its zod bound always had
--      (1 s – 30 days); the 3600 default stays.
--    - `mcp_upstream_transports` ["streamable_http"]: SSE and stdio are each an
--      admin opt-in (G4); stdio also needs the host opt-in
--      REGULAIT_MCP_STDIO_ALLOWED_DIRS.
--    - `mcp_protocol_methods` []: every non-tool MCP method is refused until an
--      admin enables it by name (G3).
-- 2. `mcp_servers`
--    - `transport` (streamable_http | sse | stdio), default streamable_http, so
--      every existing server keeps the transport it already uses.
--    - `stdio_command` / `stdio_args` / `stdio_command_digest`: the absolute
--      command, its fixed argv (a JSON array of strings, never a shell line) and
--      the command's sha256 pinned at registration.
--    - `mcp_servers_transport_shape`: a stdio row has `url = 'stdio:' || name`,
--      a command, an argv array and a digest; any other row has none of them and
--      a url that is not a `stdio:` sentinel. The sentinel fails the egress
--      check on any path that forgets to branch on transport, so such a path
--      fails closed. (Renaming a stdio server must rewrite its url too.)
--    - `owner_user_id` (I9; ON DELETE SET NULL → the row reads "orphaned"/
--      "unowned", it is never deleted with its owner).
-- 3. `connectors.owner_user_id`, the same.
-- 4. `chatops_connections.outlook_recipient_allow_list`: exact lower-cased
--    mailboxes (strings), at most 50, non-empty only on an outlook connection.
--    The registered mailbox is always a recipient and is not repeated here.
-- 5. `ai_incident_links`: object type `conversation` (an incident can hold a
--    conversation as evidence; the retention sweep must not purge it).
-- 6. Indexes for the oldest-first retention sweeps: `semantic_cache(created_at)`
--    and `conversations(updated_at)`.

ALTER TABLE "org_settings" ADD COLUMN "conversation_retention_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "mcp_upstream_transports" jsonb DEFAULT '["streamable_http"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "mcp_protocol_methods" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_conversation_retention_days_check" CHECK ("conversation_retention_days" BETWEEN 1 AND 2555);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_semantic_cache_ttl_seconds_check" CHECK ("semantic_cache_ttl_seconds" BETWEEN 1 AND 2592000);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_mcp_upstream_transports_check" CHECK (
  jsonb_typeof("mcp_upstream_transports") = 'array'
  AND "mcp_upstream_transports" <@ '["streamable_http", "sse", "stdio"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_mcp_protocol_methods_check" CHECK (
  jsonb_typeof("mcp_protocol_methods") = 'array'
  AND "mcp_protocol_methods" <@ '["resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "transport" text DEFAULT 'streamable_http' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "stdio_command" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "stdio_args" jsonb;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "stdio_command_digest" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_check" CHECK ("transport" IN ('streamable_http', 'sse', 'stdio'));
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_shape" CHECK (
  (
    "transport" = 'stdio'
    AND "url" = 'stdio:' || "name"
    AND "stdio_command" IS NOT NULL
    AND "stdio_args" IS NOT NULL
    AND jsonb_typeof("stdio_args") = 'array'
    AND "stdio_command_digest" IS NOT NULL
  )
  OR (
    "transport" <> 'stdio'
    AND "url" NOT LIKE 'stdio:%'
    AND "stdio_command" IS NULL
    AND "stdio_args" IS NULL
    AND "stdio_command_digest" IS NULL
  )
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "owner_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN "outlook_recipient_allow_list" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_outlook_allow_list_check" CHECK (
  jsonb_typeof("outlook_recipient_allow_list") = 'array'
  AND jsonb_array_length("outlook_recipient_allow_list") <= 50
  AND NOT jsonb_path_exists("outlook_recipient_allow_list", '$[*] ? (@.type() != "string")')
  AND "outlook_recipient_allow_list"::text = lower("outlook_recipient_allow_list"::text)
);
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_outlook_allow_list_provider_check" CHECK (
  "outlook_recipient_allow_list" = '[]'::jsonb OR "provider" = 'outlook'
);
--> statement-breakpoint
ALTER TABLE "ai_incident_links" DROP CONSTRAINT "ai_incident_links_object_type_check";
--> statement-breakpoint
ALTER TABLE "ai_incident_links" ADD CONSTRAINT "ai_incident_links_object_type_check" CHECK ("object_type" IN ('agent', 'model', 'vendor', 'risk', 'condition', 'eval_run', 'redteam_run', 'governance_alert', 'feedback', 'pm_link', 'conversation'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_cache_created_at_idx" ON "semantic_cache" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_updated_at_idx" ON "conversations" ("updated_at");
