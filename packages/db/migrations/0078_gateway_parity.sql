-- ADR-0066 — GATEWAY PARITY: virtual keys, per-key allow-lists and budgets,
-- and provider fallback chains.
--
-- The parity targets (LiteLLM, Portkey, Cloudflare AI Gateway) all ship a
-- "virtual key": you hand a developer a key we minted instead of the vendor key
-- we hold, and you attach a model allow-list, a budget and an expiry to it.
-- Without that, adopting this gateway means either handing out the real vendor
-- key (which defeats the purpose) or minting a full RegulAIt API key that
-- carries the holder's ENTIRE entitlement set with no budget of its own.
--
-- THE INVARIANT THIS MIGRATION EXISTS TO MAKE STRUCTURAL. A virtual key can
-- only ever NARROW. It has an owning user, and a dispatch on it is allowed iff
-- the OWNER is entitled to the served agent AND the key's own allow-list admits
-- it. There is no column here that can add an entitlement — `allowed_models` is
-- intersected with the policy kernel's answer, never substituted for it. This
-- is the same ceiling shape ADR-0062 used for egress and ADR-0007's per-user
-- policy uses for tier.
--
-- WHY A SEPARATE TABLE FROM `api_keys`. An ordinary API key IS its user: it
-- carries their admin-ness and reaches every route they may reach. A virtual
-- key is a scoped, budgeted, expiring proxy that reaches only the dispatch
-- surfaces. Adding nullable budget/allow-list columns to `api_keys` would have
-- turned every existing read of that table into a place where a caller can
-- forget to check a budget; a second table cannot be read by accident.
--
-- WHY FALLBACK CHAINS ARE AGENT→AGENT, NOT AGENT→PROVIDER. Entitlement in this
-- system is granted on AGENTS. A chain expressed in providers would name hops
-- the policy kernel has no opinion about, and re-evaluating entitlement per hop
-- — the single property that keeps a fallback from being a privilege-escalation
-- primitive — would be impossible.

-- ---------------------------------------------------------------------------
-- 1. virtual_keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "virtual_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- the human whose entitlements are this key's CEILING. Cascade: leaving a
  -- key alive past its owner would leave a credential with nothing to
  -- intersect against, which is the one state this design must not have.
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- sha256, exactly as api_keys.token_hash. The token is returned ONCE.
  "token_hash" text NOT NULL UNIQUE,
  -- NULL = no per-key model restriction (the owner's entitlements alone are
  -- the ceiling). Entries match the served agent by provider-native model id
  -- OR by agent id — the two things a client can actually name.
  "allowed_models" jsonb,
  -- NULL = no per-key budget. Enforced BEFORE dispatch against spent_usd.
  "budget_usd" double precision,
  "spent_usd" double precision DEFAULT 0 NOT NULL,
  -- the PLATFORM credential this key proxies to; NULL = the ordinary
  -- resolution chain. RESTRICT: a credential a live virtual key still points
  -- at cannot be deleted out from under it.
  "upstream_credential_id" uuid REFERENCES "model_credentials"("id") ON DELETE RESTRICT,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "virtual_keys_budget_check" CHECK ("budget_usd" IS NULL OR "budget_usd" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "virtual_keys_user_idx" ON "virtual_keys" ("user_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. usage_events.virtual_key_id — per-key spend rides the ONE ledger
-- ---------------------------------------------------------------------------
-- FK-free like every other attribution column on this table: a revoked and
-- deleted key must not take its spend history with it. NULL on every
-- pre-0078 row and on every call that did not arrive on a virtual key.
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "virtual_key_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_virtual_key_idx" ON "usage_events" ("virtual_key_id", "at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. agent_fallbacks — the ordered chain
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "agent_fallbacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "fallback_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- a chain that starts by re-trying the agent it is a chain FOR is an
  -- infinite loop expressed as data. Refused in the database, not only in a
  -- handler, so no future writer can reintroduce it.
  CONSTRAINT "agent_fallbacks_no_self_check" CHECK ("agent_id" <> "fallback_agent_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallbacks_position_uq" ON "agent_fallbacks" ("agent_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_fallbacks_target_uq" ON "agent_fallbacks" ("agent_id","fallback_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_fallbacks_agent_idx" ON "agent_fallbacks" ("agent_id","position");
