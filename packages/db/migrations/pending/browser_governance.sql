-- ADR-0334 (lane E16): managed browser extension governance, surface (a) (AI assistants in browser tabs).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `browser_governance_settings`: one row (id = 1), strict by default (ADR-0180): off, `enforce`, prompt capture
--    off, captured prompts kept 30 days (owner decision B2; longer is a relaxation). Turning it on, `audit` mode and prompt capture are each a `settings_relax` step-up, audited (the routes).
-- 2. `browser_site_rules` + `browser_site_account_domains`: an admin's decision per catalogue site, and the account
--    domains the browser profile must be signed in with (a join table, ADR-0200 3NF). A site with no rule is denied.
-- 3. `browser_enrolment_tokens`: capped bulk tokens (`rgbe_`), at most 30 days, stored as SHA-256 only.
-- 4. `browser_devices`: one row per installed extension. Its key and tokens are a workload identity of the new kind
--    `browser_extension` (ADR-0195 SD4b's endpoint-agent pattern: S6 key binding, S7 DPoP-bound self tokens), so
--    `workload_identities`' kind and subject CHECKs are widened here, as 0207 did. Revoked, never deleted.
-- 5. `browser_events`, `browser_prompt_captures`: APPEND-ONLY EVIDENCE. One guard function refuses UPDATE and DELETE,
--    and a statement trigger refuses TRUNCATE (the 0185 pattern). The one UPDATE admitted besides a deleted user's
--    SET NULL is the data-key re-encryption walk rewriting a capture's ciphertext. The one DELETE admitted is the
--    prompt-capture retention sweep's (owner decision B2: 30 days by default). Events are kept (no retention yet).
--
-- 6. Device binding (#867 security review): a device is bound to the first profile account it presents
--    (`bound_subject`, the keyed pseudonym, and `bound_user_id` when it matches a person). Every later request
--    must present the same account; any other is refused and audited, never attributed. Every evidence row says
--    how its person was established (`attribution`): `device_asserted`, the only kind this slice can establish
--    (identity-provider verification of the account is a recorded follow-up).
-- 7. Row-level security (ADR-0234) on all seven tables, FORCED: admins, scheduler jobs (`system_task`) and
--    migrations see every row; a browser extension's request (`credential_request`) reads the settings and rules,
--    reads and counts enrolment tokens at registration, and reaches only ITS OWN device row and evidence, through
--    the transaction-local `regulait.browser_identity_id` the gateway sets to the authenticated workload identity.
--
-- One new function, pinned to `search_path = pg_catalog, public, pg_temp` (0185). Single-tenant deployment: like the
-- other register tables (0281) there is no tenant column; 0272's default privileges grant the app role.

ALTER TABLE "workload_identities" DROP CONSTRAINT IF EXISTS "workload_identities_kind_check";
--> statement-breakpoint
ALTER TABLE "workload_identities" ADD CONSTRAINT "workload_identities_kind_check"
  CHECK ("kind" IN ('agent', 'builder_agent', 'engine_runner', 'worker_runtime', 'pdp', 'endpoint_agent', 'browser_extension'));
--> statement-breakpoint
ALTER TABLE "workload_identities" DROP CONSTRAINT IF EXISTS "workload_identities_subject_check";
--> statement-breakpoint
ALTER TABLE "workload_identities" ADD CONSTRAINT "workload_identities_subject_check" CHECK (
  ("kind" = 'agent' AND "agent_id" IS NOT NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
  OR ("kind" = 'builder_agent' AND "agent_id" IS NULL AND "builder_agent_id" IS NOT NULL AND "engine_runner_id" IS NULL)
  OR ("kind" = 'engine_runner' AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NOT NULL)
  OR ("kind" IN ('worker_runtime', 'pdp', 'endpoint_agent', 'browser_extension') AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_governance_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "mode" text DEFAULT 'enforce' NOT NULL,
  "prompt_capture_enabled" boolean DEFAULT false NOT NULL,
  "prompt_capture_retention_days" integer DEFAULT 30 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "browser_governance_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "browser_governance_settings_mode_check" CHECK ("mode" IN ('enforce', 'audit')),
  CONSTRAINT "browser_governance_settings_retention_check" CHECK ("prompt_capture_retention_days" BETWEEN 1 AND 3650)
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
-- `devices_enrolled` is a deliberate counter (ADR-0200 exception): the cap is enforced under this row's FOR UPDATE
-- lock, and it counts registrations ever made, including devices later revoked, which a count of rows would not.
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
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "os" text NOT NULL,
  "browser_major" integer NOT NULL,
  "extension_version" text NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- the account the device is bound to: its keyed pseudonym (point-in-time evidence, ADR-0200 exception), the person
  -- it matched when bound, and when
  "bound_subject" text,
  "bound_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "bound_at" timestamp with time zone,
  CONSTRAINT "browser_devices_bound_check" CHECK (("bound_subject" IS NULL) = ("bound_at" IS NULL) AND ("bound_user_id" IS NULL OR "bound_subject" IS NOT NULL)),
  CONSTRAINT "browser_devices_bound_subject_check" CHECK ("bound_subject" IS NULL OR "bound_subject" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "browser_devices_os_check" CHECK ("os" IN ('mac', 'win', 'linux', 'cros', 'other')),
  CONSTRAINT "browser_devices_major_check" CHECK ("browser_major" BETWEEN 1 AND 10000),
  CONSTRAINT "browser_devices_version_check" CHECK (char_length("extension_version") BETWEEN 1 AND 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "browser_devices_identity_uq" ON "browser_devices" ("identity_id");
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
  "attribution" text DEFAULT 'device_asserted' NOT NULL,
  CONSTRAINT "browser_events_attribution_check" CHECK ("attribution" IN ('device_asserted')),
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
  "attribution" text DEFAULT 'device_asserted' NOT NULL,
  CONSTRAINT "browser_prompt_captures_attribution_check" CHECK ("attribution" IN ('device_asserted')),
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
  -- the data-key re-encryption walk (the 0142 `regulait.secret_reencrypt` setting) rewrites a captured prompt's
  -- ciphertext under the new key, and nothing else in the row
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'browser_prompt_captures'
     AND coalesce(current_setting('regulait.secret_reencrypt', true), '') = 'on'
     AND (to_jsonb(NEW) - 'text_ciphertext') = (to_jsonb(OLD) - 'text_ciphertext') THEN
    RETURN NEW;
  END IF;
  -- owner decision B2: the prompt-capture retention sweep deletes a capture past the admin's retention. It sets the
  -- transaction-local `regulait.browser_capture_retention_cutoff`; a DELETE is admitted only when the setting parses,
  -- the cutoff is in the past by the DATABASE clock, and the row arrived before it (the ADR-0302 pattern). Events are
  -- never deleted this way.
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'browser_prompt_captures' THEN
    DECLARE
      raw text := coalesce(current_setting('regulait.browser_capture_retention_cutoff', true), '');
      cutoff timestamptz;
    BEGIN
      IF raw <> '' THEN
        BEGIN
          cutoff := raw::timestamptz;
        EXCEPTION WHEN others THEN
          cutoff := NULL;
        END;
        IF cutoff IS NOT NULL AND cutoff < now() AND OLD.received_at < cutoff THEN
          RETURN OLD;
        END IF;
      END IF;
    END;
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

-- ---- 7. row-level security (ADR-0234; #867 security review) ----------------------------------------------------
--> statement-breakpoint
ALTER TABLE "browser_governance_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_governance_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_governance_settings_admin" ON "browser_governance_settings";
--> statement-breakpoint
CREATE POLICY "browser_governance_settings_admin" ON "browser_governance_settings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_governance_settings_extension_read" ON "browser_governance_settings";
--> statement-breakpoint
CREATE POLICY "browser_governance_settings_extension_read" ON "browser_governance_settings" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request');
--> statement-breakpoint
ALTER TABLE "browser_site_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_site_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_site_rules_admin" ON "browser_site_rules";
--> statement-breakpoint
CREATE POLICY "browser_site_rules_admin" ON "browser_site_rules" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_site_rules_extension_read" ON "browser_site_rules";
--> statement-breakpoint
CREATE POLICY "browser_site_rules_extension_read" ON "browser_site_rules" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request');
--> statement-breakpoint
ALTER TABLE "browser_site_account_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_site_account_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_site_account_domains_admin" ON "browser_site_account_domains";
--> statement-breakpoint
CREATE POLICY "browser_site_account_domains_admin" ON "browser_site_account_domains" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_site_account_domains_extension_read" ON "browser_site_account_domains";
--> statement-breakpoint
CREATE POLICY "browser_site_account_domains_extension_read" ON "browser_site_account_domains" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request');
--> statement-breakpoint
ALTER TABLE "browser_enrolment_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_enrolment_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_enrolment_tokens_admin" ON "browser_enrolment_tokens";
--> statement-breakpoint
CREATE POLICY "browser_enrolment_tokens_admin" ON "browser_enrolment_tokens" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_enrolment_tokens_extension_read" ON "browser_enrolment_tokens";
--> statement-breakpoint
CREATE POLICY "browser_enrolment_tokens_extension_read" ON "browser_enrolment_tokens" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request');
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_enrolment_tokens_extension_count" ON "browser_enrolment_tokens";
--> statement-breakpoint
CREATE POLICY "browser_enrolment_tokens_extension_count" ON "browser_enrolment_tokens" FOR UPDATE
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request')
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'credential_request');
--> statement-breakpoint
ALTER TABLE "browser_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_devices_admin" ON "browser_devices";
--> statement-breakpoint
CREATE POLICY "browser_devices_admin" ON "browser_devices" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_devices_own_read" ON "browser_devices";
--> statement-breakpoint
CREATE POLICY "browser_devices_own_read" ON "browser_devices" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_devices_own_update" ON "browser_devices";
--> statement-breakpoint
CREATE POLICY "browser_devices_own_update" ON "browser_devices" FOR UPDATE
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid)
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid);
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_devices_own_insert" ON "browser_devices";
--> statement-breakpoint
CREATE POLICY "browser_devices_own_insert" ON "browser_devices" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "browser_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_events_admin" ON "browser_events";
--> statement-breakpoint
CREATE POLICY "browser_events_admin" ON "browser_events" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_events_own_insert" ON "browser_events";
--> statement-breakpoint
CREATE POLICY "browser_events_own_insert" ON "browser_events" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "device_id" IN (SELECT d."id" FROM "browser_devices" d WHERE d."identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid AND d."revoked_at" IS NULL));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_events_own_read" ON "browser_events";
--> statement-breakpoint
CREATE POLICY "browser_events_own_read" ON "browser_events" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "device_id" IN (SELECT d."id" FROM "browser_devices" d WHERE d."identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid AND d."revoked_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "browser_prompt_captures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_prompt_captures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_prompt_captures_admin" ON "browser_prompt_captures";
--> statement-breakpoint
CREATE POLICY "browser_prompt_captures_admin" ON "browser_prompt_captures" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_prompt_captures_own_insert" ON "browser_prompt_captures";
--> statement-breakpoint
CREATE POLICY "browser_prompt_captures_own_insert" ON "browser_prompt_captures" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "device_id" IN (SELECT d."id" FROM "browser_devices" d WHERE d."identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid AND d."revoked_at" IS NULL));
--> statement-breakpoint
DROP POLICY IF EXISTS "browser_prompt_captures_own_read" ON "browser_prompt_captures";
--> statement-breakpoint
CREATE POLICY "browser_prompt_captures_own_read" ON "browser_prompt_captures" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'credential_request' AND "device_id" IN (SELECT d."id" FROM "browser_devices" d WHERE d."identity_id" = nullif(current_setting('regulait.browser_identity_id', true), '')::uuid AND d."revoked_at" IS NULL));
