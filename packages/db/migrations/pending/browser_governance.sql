-- ADR-0334 (lane E16): managed browser extension governance, surface (a) (AI assistants in browser tabs).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `browser_governance_settings`: one row (id = 1), strict by default (ADR-0180): off, `enforce`, prompt capture
--    off. Turning it on, `audit` mode and prompt capture are each a `settings_relax` step-up, audited (the routes).
-- 2. `browser_site_rules` + `browser_site_account_domains`: an admin's decision per catalogue site, and the account
--    domains the browser profile must be signed in with (a join table, ADR-0200 3NF). A site with no rule is denied.
-- 3. `browser_enrolment_tokens`: capped bulk tokens (`rgbe_`), at most 30 days, stored as SHA-256 only.
-- 4. `browser_devices`: one row per installed extension and its install-time P-256 key. Revoked, never deleted.
-- 5. `browser_events`, `browser_prompt_captures`: APPEND-ONLY EVIDENCE. One guard function refuses UPDATE and DELETE,
--    and a statement trigger refuses TRUNCATE (the 0185 pattern). Retention for both is a recorded follow-up.
--
-- One new function, pinned to `search_path = pg_catalog, public, pg_temp` (0185). Single-tenant deployment: like the
-- other register tables (0281) there is no tenant column; 0272's default privileges grant the app role.

CREATE TABLE IF NOT EXISTS "browser_governance_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "mode" text DEFAULT 'enforce' NOT NULL,
  "prompt_capture_enabled" boolean DEFAULT false NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_governance_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "browser_governance_settings_mode_check" CHECK ("mode" IN ('enforce', 'audit'))
);
--> statement-breakpoint
INSERT INTO "browser_governance_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_site_rules" (
  "site_id" text PRIMARY KEY NOT NULL,
  "decision" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_site_rules_site_check" CHECK ("site_id" IN (
    'ep-openai-chatgpt', 'ep-openai-chat-legacy', 'ep-anthropic-claude-web', 'ep-google-gemini-web',
    'ep-microsoft-copilot-web', 'ep-perplexity-web', 'ep-deepseek-chat-web', 'ep-poe-web', 'ep-characterai-web'
  )),
  CONSTRAINT "browser_site_rules_decision_check" CHECK ("decision" IN ('allow', 'deny'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_site_account_domains" (
  "site_id" text NOT NULL REFERENCES "browser_site_rules"("site_id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  CONSTRAINT "browser_site_account_domains_pk" PRIMARY KEY ("site_id", "domain"),
  CONSTRAINT "browser_site_account_domains_domain_check" CHECK (char_length("domain") BETWEEN 3 AND 253 AND "domain" = lower("domain"))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_enrolment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "token_hash" text NOT NULL,
  "device_cap" integer NOT NULL,
  "devices_enrolled" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_enrolment_tokens_label_check" CHECK (char_length("label") BETWEEN 1 AND 120),
  CONSTRAINT "browser_enrolment_tokens_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "browser_enrolment_tokens_cap_check" CHECK ("device_cap" BETWEEN 1 AND 100000 AND "devices_enrolled" BETWEEN 0 AND "device_cap"),
  CONSTRAINT "browser_enrolment_tokens_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_enrolment_tokens_hash_uq" ON "browser_enrolment_tokens" ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_id" uuid NOT NULL REFERENCES "browser_enrolment_tokens"("id") ON DELETE RESTRICT,
  "jwk_thumbprint" text NOT NULL,
  "public_jwk" jsonb NOT NULL,
  "os" text NOT NULL,
  "browser_major" integer NOT NULL,
  "extension_version" text NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "browser_devices_thumbprint_check" CHECK ("jwk_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "browser_devices_jwk_check" CHECK (
    jsonb_typeof("public_jwk") = 'object' AND "public_jwk" ->> 'kty' = 'EC' AND "public_jwk" ->> 'crv' = 'P-256'
    AND NOT ("public_jwk" ? 'd')
  ),
  CONSTRAINT "browser_devices_os_check" CHECK ("os" IN ('mac', 'win', 'linux', 'cros', 'other')),
  CONSTRAINT "browser_devices_major_check" CHECK ("browser_major" BETWEEN 1 AND 10000),
  CONSTRAINT "browser_devices_version_check" CHECK (char_length("extension_version") BETWEEN 1 AND 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_devices_thumbprint_uq" ON "browser_devices" ("jwk_thumbprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_devices_token_idx" ON "browser_devices" ("token_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "browser_devices"("id") ON DELETE RESTRICT,
  "event_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "outcome" text NOT NULL,
  "code" text NOT NULL,
  "site_id" text NOT NULL,
  "rule_ids" text[] NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "subject_pseudonym" text NOT NULL,
  "conversation_ref" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "audit_id" uuid NOT NULL,
  CONSTRAINT "browser_events_kind_check" CHECK ("kind" IN ('site_blocked', 'account_blocked', 'dlp_blocked')),
  CONSTRAINT "browser_events_outcome_check" CHECK ("outcome" IN ('blocked', 'would_block')),
  CONSTRAINT "browser_events_code_check" CHECK ("code" ~ '^[a-z_]{1,40}$'),
  CONSTRAINT "browser_events_site_check" CHECK ("site_id" ~ '^ep-[a-z0-9-]{1,60}$'),
  CONSTRAINT "browser_events_rules_check" CHECK (cardinality("rule_ids") <= 32),
  CONSTRAINT "browser_events_subject_check" CHECK ("subject_pseudonym" = '' OR "subject_pseudonym" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "browser_events_conversation_check" CHECK ("conversation_ref" IS NULL OR "conversation_ref" ~ '^cnv:[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_events_device_event_uq" ON "browser_events" ("device_id", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_events_received_idx" ON "browser_events" ("received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_events_user_idx" ON "browser_events" ("user_id", "received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_prompt_captures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "browser_devices"("id") ON DELETE RESTRICT,
  "capture_id" uuid NOT NULL,
  "site_id" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "subject_pseudonym" text NOT NULL,
  "conversation_ref" text NOT NULL,
  "text_ciphertext" text NOT NULL,
  "text_chars" integer NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "audit_id" uuid NOT NULL,
  CONSTRAINT "browser_prompt_captures_site_check" CHECK ("site_id" ~ '^ep-[a-z0-9-]{1,60}$'),
  CONSTRAINT "browser_prompt_captures_subject_check" CHECK ("subject_pseudonym" = '' OR "subject_pseudonym" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "browser_prompt_captures_conversation_check" CHECK ("conversation_ref" ~ '^cnv:[0-9a-f]{32}$'),
  CONSTRAINT "browser_prompt_captures_chars_check" CHECK ("text_chars" BETWEEN 1 AND 16000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_prompt_captures_device_capture_uq" ON "browser_prompt_captures" ("device_id", "capture_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_prompt_captures_received_idx" ON "browser_prompt_captures" ("received_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "browser_evidence_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- the one change admitted: a deleted user's ON DELETE SET NULL (an RI action, so a nested trigger), and nothing else
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are append-only browser governance evidence (ADR-0334)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "browser_events_guard" ON "browser_events";
--> statement-breakpoint
CREATE TRIGGER "browser_events_guard" BEFORE UPDATE OR DELETE ON "browser_events"
  FOR EACH ROW EXECUTE FUNCTION "browser_evidence_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "browser_events_no_truncate" ON public."browser_events";
--> statement-breakpoint
CREATE TRIGGER "browser_events_no_truncate" BEFORE TRUNCATE ON public."browser_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "browser_prompt_captures_guard" ON "browser_prompt_captures";
--> statement-breakpoint
CREATE TRIGGER "browser_prompt_captures_guard" BEFORE UPDATE OR DELETE ON "browser_prompt_captures"
  FOR EACH ROW EXECUTE FUNCTION "browser_evidence_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "browser_prompt_captures_no_truncate" ON public."browser_prompt_captures";
--> statement-breakpoint
CREATE TRIGGER "browser_prompt_captures_no_truncate" BEFORE TRUNCATE ON public."browser_prompt_captures"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
