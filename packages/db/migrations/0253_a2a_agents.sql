-- ADR-0219 (P10): governed agent-to-agent (A2A) calls. Hand-authored (never drizzle-kit generate). Re-runnable: every
-- statement is idempotent.
--
-- 1. `org_settings.a2a_enabled`, default false (ADR-0180): no remote agent can be registered or called until an admin
--    turns it on through the audited `PUT /v1/org/settings` (a `settings_relax` step-up). Nothing is backfilled.
-- 2. `a2a_agents`: one row per remote agent an admin registered. `card` is the agent card the gateway read through the
--    guarded fetch at registration (or the last refresh), bounded in size. `allow_private_ranges` NULL inherits the
--    org's MCP private-range default, exactly like `mcp_servers`.
-- 3. `a2a_agent_credentials`: the optional static credential sent to that agent. Its own table, so no read of
--    `a2a_agents` carries the ciphertext; the secret is the data-key envelope (secrets.ts), registered in
--    CIPHERTEXT_COLUMNS. `secret_set_at` is stamped on the database clock by the 0142 trigger.
-- 4. `a2a_agent_grants`: who may call which agent. No row = no call (default-deny). `skill_id` NULL = every skill the
--    agent's card lists; a value = that skill only. A worker never holds a grant of its own: it calls as the person
--    who started the run, narrowed by its lead's ceiling.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "a2a_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "card" jsonb NOT NULL,
  "card_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "allow_private_ranges" boolean,
  "price_per_call_usd" double precision,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "a2a_agents_name_uq" UNIQUE ("name"),
  CONSTRAINT "a2a_agents_name_check" CHECK ("name" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT "a2a_agents_url_check" CHECK (char_length("url") <= 2048 AND "url" ~ '^https?://'),
  CONSTRAINT "a2a_agents_card_check" CHECK (jsonb_typeof("card") = 'object' AND pg_column_size("card") <= 65536),
  CONSTRAINT "a2a_agents_price_check" CHECK ("price_per_call_usd" IS NULL OR ("price_per_call_usd" >= 0 AND "price_per_call_usd" <= 1000))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_agent_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "scheme" text NOT NULL,
  "header_name" text NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "secret_last4" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "a2a_agent_credentials_agent_uq" UNIQUE ("agent_id"),
  CONSTRAINT "a2a_agent_credentials_scheme_check" CHECK ("scheme" IN ('bearer', 'header')),
  CONSTRAINT "a2a_agent_credentials_header_check" CHECK (
    "header_name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'
    AND (("scheme" = 'bearer') = ("header_name" = 'authorization'))
    AND "header_name" NOT IN (
      'host', 'cookie', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
      'upgrade', 'expect', 'accept', 'accept-encoding', 'forwarded', 'via', 'origin', 'referer', 'a2a-version',
      'a2a-extensions'
    )
    AND "header_name" NOT LIKE 'content-%'
    AND "header_name" NOT LIKE 'proxy-%'
    AND "header_name" NOT LIKE 'sec-%'
    AND "header_name" NOT LIKE 'x-forwarded-%'
    AND "header_name" NOT LIKE 'regulait-%'
    AND "header_name" NOT LIKE 'x-regulait-%'
  ),
  CONSTRAINT "a2a_agent_credentials_last4_check" CHECK (char_length("secret_last4") = 4)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "a2a_agent_credentials_secret_set_trg" ON "a2a_agent_credentials";
--> statement-breakpoint
CREATE TRIGGER "a2a_agent_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "a2a_agent_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('secret_ciphertext', 'secret_set_at');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_agent_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "skill_id" text,
  "granted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "a2a_agent_grants_skill_check" CHECK ("skill_id" IS NULL OR char_length("skill_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_agent_grants_uq" ON "a2a_agent_grants" ("agent_id", "user_id", COALESCE("skill_id", ''));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_agent_grants_user_idx" ON "a2a_agent_grants" ("user_id", "agent_id");
