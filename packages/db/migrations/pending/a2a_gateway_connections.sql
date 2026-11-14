-- Lane L2 (ADR-0231 B3): agent gateway connections, ARD import, and pending cards.
-- 1. `org_settings.sap_agent_gateway_enabled`: off by default (ADR-0180); turning it on is a settings_relax step-up.
-- 2. `a2a_gateway_connections`: one agent gateway an admin connected (its ARD catalogue and the client-credentials
--    identity used only to read it). The secret is the data-key envelope.
-- 3. `a2a_agents`: the connection an agent was imported from, its ARD identifier, the card's published protocol version
--    and raw hash, and a refreshed card held for review (`pending_card`), never used for a call until accepted.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "sap_agent_gateway_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_gateway_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "base_url" text NOT NULL,
  "token_endpoint" text NOT NULL,
  "client_id" text NOT NULL,
  "client_secret_ciphertext" text NOT NULL,
  "client_secret_last4" text NOT NULL,
  "resource" text,
  "scope" text,
  "allow_private_ranges" boolean,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_imported_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "a2a_gateway_connections_name_uq" UNIQUE ("name"),
  CONSTRAINT "a2a_gateway_connections_provider_check" CHECK ("provider" IN ('sap_agent_gateway')),
  CONSTRAINT "a2a_gateway_connections_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT "a2a_gateway_connections_url_check" CHECK (char_length("base_url") <= 2048 AND char_length("token_endpoint") <= 2048),
  CONSTRAINT "a2a_gateway_connections_client_check" CHECK (char_length("client_id") BETWEEN 1 AND 512)
);
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "gateway_connection_id" uuid REFERENCES "a2a_gateway_connections"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "ard_identifier" text;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "card_protocol_version" text;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "card_raw_sha256" text;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "pending_card" jsonb;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "pending_card_raw_sha256" text;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD COLUMN IF NOT EXISTS "pending_card_fetched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD CONSTRAINT "a2a_agents_pending_card_size_check" CHECK ("pending_card" IS NULL OR (jsonb_typeof("pending_card") = 'object' AND pg_column_size("pending_card") <= 65536));
--> statement-breakpoint
ALTER TABLE "a2a_agents" ADD CONSTRAINT "a2a_agents_ard_identifier_check" CHECK ("ard_identifier" IS NULL OR char_length("ard_identifier") BETWEEN 1 AND 512);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_agents_gateway_ard_uq" ON "a2a_agents" ("gateway_connection_id", "ard_identifier");
