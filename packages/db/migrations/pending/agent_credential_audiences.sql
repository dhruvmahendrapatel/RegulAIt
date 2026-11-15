-- ADR-0315 (G7, slice 1): the portable agent credential's registered audiences, scope maps and issued credentials.
-- Pending migration (ADR-0252): numbered at merge. Hand-authored. Re-runnable: every statement is idempotent.
--
-- Default-deny (ADR-0180), first load: no audience row exists, so no credential can be issued; an atom of a grant
-- with no mapping row at its audience is never sent. Registering an audience, choosing `bearer` or a lifetime above
-- 300 s is a `settings_relax` step-up, audited. Nothing is backfilled.
--
--   agent_credential_audiences        one third-party enforcement point (the exact `aud`), its pinned algorithm,
--                                     binding and maximum lifetime
--   agent_credential_audience_scopes  grant atom (type, resource FK, kind) -> scope string at that audience (3NF)
--   agent_credentials_issued          one issued credential: jti, its status-list index, audience, grant, lifetime,
--                                     revocation. Point-in-time evidence; the token itself is never stored.
--
-- Single-tenant deployment tables carry no RLS policy (ADR-0234 scope); the admin routes are admin-only and the
-- issuance path is the workload-authenticated token endpoint.

CREATE TABLE IF NOT EXISTS "agent_credential_audiences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audience" text NOT NULL,
  "name" text NOT NULL,
  "algorithm" text DEFAULT 'ES256' NOT NULL,
  "binding" text DEFAULT 'dpop' NOT NULL,
  "max_ttl_seconds" integer DEFAULT 300 NOT NULL,
  "disabled_at" timestamp with time zone,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_credential_audiences_audience_unique" UNIQUE ("audience"),
  CONSTRAINT "agent_credential_audiences_algorithm_check" CHECK ("algorithm" IN ('ES256', 'EdDSA')),
  CONSTRAINT "agent_credential_audiences_binding_check" CHECK ("binding" IN ('dpop', 'bearer')),
  CONSTRAINT "agent_credential_audiences_ttl_check" CHECK ("max_ttl_seconds" BETWEEN 60 AND 900),
  CONSTRAINT "agent_credential_audiences_audience_check" CHECK (char_length("audience") BETWEEN 9 AND 512 AND "audience" LIKE 'https://%'),
  CONSTRAINT "agent_credential_audiences_name_check" CHECK (char_length("name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_credential_audience_scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "agent_credential_audiences"("id") ON DELETE CASCADE,
  "resource_type" text NOT NULL,
  "server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "tool_name" text,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  CONSTRAINT "agent_credential_audience_scopes_type_check" CHECK (CASE "resource_type"
    WHEN 'mcp_tool' THEN "server_id" IS NOT NULL AND "tool_name" IS NOT NULL AND "connector_id" IS NULL AND "agent_id" IS NULL
    WHEN 'connector' THEN "connector_id" IS NOT NULL AND "server_id" IS NULL AND "tool_name" IS NULL AND "agent_id" IS NULL
    WHEN 'agent' THEN "agent_id" IS NOT NULL AND "server_id" IS NULL AND "tool_name" IS NULL AND "connector_id" IS NULL
    ELSE false END),
  CONSTRAINT "agent_credential_audience_scopes_kind_check" CHECK ("kind" IN ('read', 'write')),
  CONSTRAINT "agent_credential_audience_scopes_scope_check" CHECK ("scope" ~ '^[!#-\[\]-~]{1,128}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credential_audience_scopes_audience_idx" ON "agent_credential_audience_scopes" ("audience_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_credentials_issued" (
  "jti" text PRIMARY KEY NOT NULL,
  "status_index" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "audience_id" uuid NOT NULL REFERENCES "agent_credential_audiences"("id") ON DELETE RESTRICT,
  "grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "agent_credentials_issued_jti_check" CHECK ("jti" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "agent_credentials_issued_lifetime_check" CHECK ("expires_at" > "issued_at" AND "expires_at" <= "issued_at" + interval '900 seconds')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_credentials_issued_status_index_uq" ON "agent_credentials_issued" ("status_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_credentials_issued_grant_idx" ON "agent_credentials_issued" ("grant_id");
