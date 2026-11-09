-- ADR-0238 (backlog P12(d)): down-scoped upstream credentials by RFC 8693 token exchange.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `upstream_token_exchanges`: at most one configuration per MCP server or per connector (exactly one of the two
--    foreign keys is set). No row, or a row with `enabled` false (the column default), exchanges nothing: the strict
--    default (ADR-0180). Nothing is backfilled. Admin-owned configuration like `mcp_server_upstream_credentials`, so it
--    joins no ADR-0234 RLS batch (no user-, project- or team-owned rows).
-- 2. The client secret is the data-key envelope (secrets.ts), registered in CIPHERTEXT_COLUMNS; `secret_set_at` is
--    stamped on the database clock by the 0142 trigger, so a rotation is visible.
-- 3. `upstream_token_exchange_scopes`: the per-action scope map as a join table (ADR-0200 addendum: a list is a table,
--    never a jsonb). One row per (configuration, action, scope). An action with no row is refused at call time.
-- 4. `replay_claims.namespace` gains `upstream_exchanged_token` (the SHA-256 of an issued token, never the token).
-- 5. `connector_destination` pins a connector's exchange to the destination it was configured for (ADR-0238 review).
-- 6. The CHECKs bound the shape so a row written around the API is as strict as one written through it: https
--    endpoints only, the TTL ceiling, RFC 6749 scope-token syntax.

CREATE TABLE IF NOT EXISTS "upstream_token_exchanges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "token_endpoint" text NOT NULL,
  "subject_token_audience" text NOT NULL,
  "audience" text NOT NULL,
  "resource" text,
  "client_id" text NOT NULL,
  "client_secret_ciphertext" text NOT NULL,
  "client_secret_last4" text NOT NULL,
  "max_token_ttl_seconds" integer DEFAULT 300 NOT NULL,
  -- connectors only: the origin the connector called when the exchange was configured (its credential's baseUrl, else
  -- its own; NULL = the adapter's compiled default). A call whose destination differs is refused, and a credential
  -- write that changes it turns the exchange off: the token's audience never follows a changed destination.
  "connector_destination" text,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upstream_token_exchanges_target_check" CHECK (("mcp_server_id" IS NULL) <> ("connector_id" IS NULL)),
  CONSTRAINT "upstream_token_exchanges_server_uq" UNIQUE ("mcp_server_id"),
  CONSTRAINT "upstream_token_exchanges_connector_uq" UNIQUE ("connector_id"),
  CONSTRAINT "upstream_token_exchanges_endpoint_check" CHECK ("token_endpoint" ~ '^https://[^/@#?]+' AND char_length("token_endpoint") <= 2048),
  CONSTRAINT "upstream_token_exchanges_resource_check" CHECK ("resource" IS NULL OR ("resource" ~ '^https://[^/@#?]+' AND char_length("resource") <= 2048)),
  CONSTRAINT "upstream_token_exchanges_audience_check" CHECK (
    char_length("audience") BETWEEN 1 AND 512 AND char_length("subject_token_audience") BETWEEN 1 AND 512
  ),
  CONSTRAINT "upstream_token_exchanges_client_id_check" CHECK ("client_id" ~ '^[\x21-\x7E]+$' AND char_length("client_id") <= 256),
  CONSTRAINT "upstream_token_exchanges_last4_check" CHECK (char_length("client_secret_last4") = 4),
  CONSTRAINT "upstream_token_exchanges_ttl_check" CHECK ("max_token_ttl_seconds" BETWEEN 30 AND 900),
  CONSTRAINT "upstream_token_exchanges_destination_check" CHECK (
    "connector_destination" IS NULL OR ("mcp_server_id" IS NULL AND char_length("connector_destination") <= 2048)
  )
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "upstream_token_exchanges_secret_set_trg" ON "upstream_token_exchanges";
--> statement-breakpoint
CREATE TRIGGER "upstream_token_exchanges_secret_set_trg" BEFORE INSERT OR UPDATE ON "upstream_token_exchanges"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('client_secret_ciphertext', 'secret_set_at');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upstream_token_exchange_scopes" (
  "exchange_id" uuid NOT NULL REFERENCES "upstream_token_exchanges"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "scope" text NOT NULL,
  CONSTRAINT "upstream_token_exchange_scopes_pk" PRIMARY KEY ("exchange_id", "action", "scope"),
  CONSTRAINT "upstream_token_exchange_scopes_action_check" CHECK ("action" ~ '^[A-Za-z0-9_.:/-]{1,128}$'),
  CONSTRAINT "upstream_token_exchange_scopes_scope_check" CHECK ("scope" ~ '^[\x21\x23-\x5B\x5D-\x7E]{1,128}$')
);
--> statement-breakpoint
ALTER TABLE "replay_claims" DROP CONSTRAINT IF EXISTS "replay_claims_namespace_check";
--> statement-breakpoint
ALTER TABLE "replay_claims" ADD CONSTRAINT "replay_claims_namespace_check" CHECK (
  "namespace" IN ('client_assertion', 'as_dpop', 'rs_dpop', 'human_delegation_proof', 'delegation_authz', 'executor_channel', 'upstream_exchanged_token')
);
