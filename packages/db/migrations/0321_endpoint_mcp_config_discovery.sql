-- Pending migration endpoint_mcp_config_discovery (numbered at merge, ADR-0252). ADR-0259 (P35): discovery of MCP client configs on employee machines, through the read-only
-- ADR-0195 SD4 endpoint agent. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `discovery_settings.endpoint_mcp_config_enabled`: the org switch, default false (ADR-0180 first-load posture).
--    Turning it on is a `settings_relax` step-up, audited; turning it off is free. While it is off the gateway serves
--    no opt-in for the agent's `mcp_config` collector and refuses (counts, never stores) any mcp_config fact.
-- 2. `endpoint_agent_reports.facts_mcp_refused`: how many mcp_config facts a report carried while the switch was off.
-- 3. `endpoint_mcp_servers`: the MCP servers each device's host configs name, one row per device, config file and
--    server entry. Point-in-time evidence from the device's signed report, refreshed by each newer report and
--    deleted with the device or past the endpoint retention (ADR-0195 decision 20). It never holds an argument, an
--    env or header value, a URL path or query, or a key: only the shapes the agent let through, risk flag names and
--    the secret TYPES (rule ids).
-- 4. `endpoint_mcp_server_links`: an admin's statement that a configured server identity (a package, a remote host
--    or a command) is an approved server in the `mcp_servers` registry. One row per identity; audited.
--
-- No function or trigger, so the 0185 guards have nothing new to check. Discovery tables are admin-scope, not
-- per-user tenant tables, so no RLS policy is added (as for every other ADR-0195 table); the 0272 default privileges
-- give `regulait_app` its grants.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "endpoint_mcp_config_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "endpoint_agent_reports" ADD COLUMN IF NOT EXISTS "facts_mcp_refused" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "endpoint_agent_reports" DROP CONSTRAINT IF EXISTS "endpoint_agent_reports_mcp_refused_check";
--> statement-breakpoint
ALTER TABLE "endpoint_agent_reports" ADD CONSTRAINT "endpoint_agent_reports_mcp_refused_check"
  CHECK ("facts_mcp_refused" BETWEEN 0 AND "facts_received");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  -- the report that last refreshed this row (no foreign key, so a report's deletion never rewrites evidence)
  "last_report_id" uuid NOT NULL,
  -- exception (ADR-0200 addendum): signed-report evidence, copied as reported. The signature id and provider are
  -- the signed manifest's catalogue identifiers for the MCP host (as `endpoint_agent_reports.sightings` keeps them)
  "signature_id" text NOT NULL,
  "provider" text NOT NULL,
  "config_root" text NOT NULL,
  "config_path" text NOT NULL,
  "server_name" text NOT NULL,
  "transport" text NOT NULL,
  "command" text,
  "package" text,
  "package_version" text,
  "host" text,
  -- the identity a link and the registry diff use: the package, else the host, else the command
  "identity_kind" text NOT NULL,
  "identity" text NOT NULL,
  "disabled" boolean DEFAULT false NOT NULL,
  -- exception (ADR-0200 addendum): closed-vocabulary evidence sets from one signed report, not references
  "risks" text[] DEFAULT '{}'::text[] NOT NULL,
  "risky_tools" text[] DEFAULT '{}'::text[] NOT NULL,
  "auto_approved_tools" integer DEFAULT 0 NOT NULL,
  "secret_types" text[] DEFAULT '{}'::text[] NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  CONSTRAINT "endpoint_mcp_servers_entry_uq" UNIQUE ("device_id", "config_root", "config_path", "server_name", "identity_kind", "identity"),
  CONSTRAINT "endpoint_mcp_servers_transport_check" CHECK ("transport" IN ('stdio', 'http', 'sse', 'unknown')),
  CONSTRAINT "endpoint_mcp_servers_identity_check" CHECK (
    "identity_kind" IN ('package', 'host', 'command', 'unknown') AND char_length("identity") BETWEEN 1 AND 255),
  CONSTRAINT "endpoint_mcp_servers_shape_check" CHECK (
    char_length("signature_id") BETWEEN 1 AND 128 AND char_length("provider") BETWEEN 1 AND 64
    AND "config_root" IN ('home', 'system_applications', 'appdata', 'localappdata')
    AND char_length("config_path") BETWEEN 1 AND 1024 AND char_length("server_name") BETWEEN 1 AND 64
    AND ("command" IS NULL OR char_length("command") BETWEEN 1 AND 64)
    AND ("package" IS NULL OR char_length("package") BETWEEN 1 AND 255)
    AND ("package_version" IS NULL OR char_length("package_version") BETWEEN 1 AND 64)
    AND ("host" IS NULL OR char_length("host") BETWEEN 1 AND 262)),
  CONSTRAINT "endpoint_mcp_servers_risks_check" CHECK ("risks" <@ ARRAY['shell_launcher', 'container_privileged',
    'host_root_mount', 'unpinned_package', 'secret_in_args', 'plaintext_remote', 'auto_approve_all',
    'risky_tool_auto_approved']::text[]),
  CONSTRAINT "endpoint_mcp_servers_sets_check" CHECK (
    cardinality("risky_tools") <= 20 AND cardinality("secret_types") <= 32 AND "auto_approved_tools" BETWEEN 0 AND 10000),
  CONSTRAINT "endpoint_mcp_servers_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_mcp_servers_identity_idx" ON "endpoint_mcp_servers" ("identity_kind", "identity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_mcp_servers_last_seen_idx" ON "endpoint_mcp_servers" ("last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_mcp_server_links" (
  "identity_kind" text NOT NULL,
  "identity" text NOT NULL,
  "mcp_server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "linked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_mcp_server_links_pk" PRIMARY KEY ("identity_kind", "identity"),
  CONSTRAINT "endpoint_mcp_server_links_identity_check" CHECK (
    "identity_kind" IN ('package', 'host', 'command') AND char_length("identity") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_mcp_server_links_server_idx" ON "endpoint_mcp_server_links" ("mcp_server_id");
