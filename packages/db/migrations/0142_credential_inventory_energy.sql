-- ADR-0175 batch D2 remainder: A7 (non-human credential inventory) and A15
-- (estimated energy and emissions).
--
-- 1. WHEN EACH STORED SECRET WAS LAST SET. Most credential tables are written
--    by an upsert that replaces the secret in place and keeps `created_at`, so
--    "age since rotation" had no source. Each gets a nullable `*_set_at`
--    column, stamped by ONE trigger function whenever the secret column
--    changes (and on insert when a secret is present). NULL on every pre-0142
--    row: we do not know when those were last set, and the inventory says so
--    rather than guessing. The data-key re-encryption walk rewrites
--    ciphertext without changing the secret; it sets the transaction-local
--    `regulait.secret_reencrypt = 'on'`, and the trigger leaves the stamp
--    alone. api_keys and virtual_keys need no stamp: they are never rewritten
--    (a new key is a new row), so their age since rotation is their age.
-- 2. org_settings: `credential_unused_days` (DEFAULT 90) is the inventory's
--    "unused" threshold; `stale_credential_alerts` (DEFAULT false) decides
--    whether the `stale_credentials` monitor rule raises alert episodes or
--    only shows flags on the inventory page; `energy_region` names the grid
--    region whose intensity overrides the org default for the A15 estimate.
-- 3. `energy_factors`: admin-entered factors for the A15 estimate. A model row
--    holds Wh per 1k input and output tokens; a grid row holds gCO2e per kWh
--    ('default' or a region name). Every row carries a source note and a
--    version. This migration inserts NO rows: we ship no default factor for
--    any real model, and no default grid intensity.
--
-- Additive and idempotent.

CREATE OR REPLACE FUNCTION "regulait_stamp_secret_set"() RETURNS trigger AS $$
DECLARE
  secret_col text := TG_ARGV[0];
  stamp_col text := TG_ARGV[1];
  new_v text := to_jsonb(NEW) ->> TG_ARGV[0];
  old_v text;
BEGIN
  IF coalesce(current_setting('regulait.secret_reencrypt', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF new_v IS NOT NULL THEN
      NEW := jsonb_populate_record(NEW, jsonb_build_object(stamp_col, now()));
    END IF;
    RETURN NEW;
  END IF;
  old_v := to_jsonb(OLD) ->> secret_col;
  IF new_v IS DISTINCT FROM old_v THEN
    NEW := jsonb_populate_record(
      NEW,
      jsonb_build_object(stamp_col, CASE WHEN new_v IS NULL THEN NULL ELSE now() END)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "scim_tokens_secret_set_trg" ON "scim_tokens";
--> statement-breakpoint
CREATE TRIGGER "scim_tokens_secret_set_trg" BEFORE INSERT OR UPDATE ON "scim_tokens"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('token_hash', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "oidc_providers_secret_set_trg" ON "oidc_providers";
--> statement-breakpoint
CREATE TRIGGER "oidc_providers_secret_set_trg" BEFORE INSERT OR UPDATE ON "oidc_providers"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('client_secret_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "saml_providers" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "saml_providers_secret_set_trg" ON "saml_providers";
--> statement-breakpoint
CREATE TRIGGER "saml_providers_secret_set_trg" BEFORE INSERT OR UPDATE ON "saml_providers"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('sp_private_key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "model_credentials" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "model_credentials_secret_set_trg" ON "model_credentials";
--> statement-breakpoint
CREATE TRIGGER "model_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "model_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "user_model_credentials" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "user_model_credentials_secret_set_trg" ON "user_model_credentials";
--> statement-breakpoint
CREATE TRIGGER "user_model_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "user_model_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "custom_model_providers" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "custom_model_providers_secret_set_trg" ON "custom_model_providers";
--> statement-breakpoint
CREATE TRIGGER "custom_model_providers_secret_set_trg" BEFORE INSERT OR UPDATE ON "custom_model_providers"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "external_scorers" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "external_scorers_secret_set_trg" ON "external_scorers";
--> statement-breakpoint
CREATE TRIGGER "external_scorers_secret_set_trg" BEFORE INSERT OR UPDATE ON "external_scorers"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "connector_credentials_secret_set_trg" ON "connector_credentials";
--> statement-breakpoint
CREATE TRIGGER "connector_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "connector_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('token_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "git_connections" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "git_connections_secret_set_trg" ON "git_connections";
--> statement-breakpoint
CREATE TRIGGER "git_connections_secret_set_trg" BEFORE INSERT OR UPDATE ON "git_connections"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('token_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "pm_connections" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pm_connections" ADD COLUMN IF NOT EXISTS "webhook_secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "pm_connections_secret_set_trg" ON "pm_connections";
--> statement-breakpoint
CREATE TRIGGER "pm_connections_secret_set_trg" BEFORE INSERT OR UPDATE ON "pm_connections"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('token_ciphertext', 'secret_set_at');
--> statement-breakpoint
-- keyed on the HASH, which a re-encryption never touches
DROP TRIGGER IF EXISTS "pm_connections_webhook_secret_set_trg" ON "pm_connections";
--> statement-breakpoint
CREATE TRIGGER "pm_connections_webhook_secret_set_trg" BEFORE INSERT OR UPDATE ON "pm_connections"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('webhook_secret_hash', 'webhook_secret_set_at');
--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "deploy_targets_secret_set_trg" ON "deploy_targets";
--> statement-breakpoint
CREATE TRIGGER "deploy_targets_secret_set_trg" BEFORE INSERT OR UPDATE ON "deploy_targets"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('credential_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "chatops_connections_secret_set_trg" ON "chatops_connections";
--> statement-breakpoint
CREATE TRIGGER "chatops_connections_secret_set_trg" BEFORE INSERT OR UPDATE ON "chatops_connections"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('signing_secret_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "training_backend_configs" ADD COLUMN IF NOT EXISTS "secret_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "training_backend_configs_secret_set_trg" ON "training_backend_configs";
--> statement-breakpoint
CREATE TRIGGER "training_backend_configs_secret_set_trg" BEFORE INSERT OR UPDATE ON "training_backend_configs"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('key_ciphertext', 'secret_set_at');
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_otlp_headers_set_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "org_settings_otlp_headers_set_trg" ON "org_settings";
--> statement-breakpoint
CREATE TRIGGER "org_settings_otlp_headers_set_trg" BEFORE INSERT OR UPDATE ON "org_settings"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('tracing_otlp_headers_ciphertext', 'tracing_otlp_headers_set_at');
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "credential_unused_days" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_credential_unused_days_ck";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_credential_unused_days_ck"
  CHECK ("credential_unused_days" >= 1 AND "credential_unused_days" <= 3650);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "stale_credential_alerts" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "energy_region" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "energy_factors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "subject" text NOT NULL,
  "wh_per_1k_input" double precision,
  "wh_per_1k_output" double precision,
  "g_co2e_per_kwh" double precision,
  "source_note" text NOT NULL,
  "version" text NOT NULL,
  "demo" boolean DEFAULT false NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "energy_factors_kind_ck" CHECK ("kind" IN ('model', 'grid')),
  CONSTRAINT "energy_factors_shape_ck" CHECK (
    ("kind" = 'model' AND "wh_per_1k_input" IS NOT NULL AND "wh_per_1k_output" IS NOT NULL
      AND "wh_per_1k_input" >= 0 AND "wh_per_1k_output" >= 0 AND "g_co2e_per_kwh" IS NULL)
    OR
    ("kind" = 'grid' AND "g_co2e_per_kwh" IS NOT NULL AND "g_co2e_per_kwh" >= 0
      AND "wh_per_1k_input" IS NULL AND "wh_per_1k_output" IS NULL)
  ),
  CONSTRAINT "energy_factors_source_ck" CHECK (length(btrim("source_note")) > 0 AND length(btrim("version")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "energy_factors_kind_subject_uq" ON "energy_factors" ("kind", lower("subject"));
--> statement-breakpoint
-- 4. (review fix) The credential inventory reads the usage ledger only in a
--    window, and per credential: a connector's last use and linked projects
--    by (connector_id, at), partial because only connector rows carry one. A
--    virtual key's links by (virtual_key_id, at): that index already exists
--    (`usage_events_virtual_key_idx`, migration 0078) and is not recreated.
CREATE INDEX IF NOT EXISTS "usage_events_connector_at_idx" ON "usage_events" ("connector_id", "at")
  WHERE "connector_id" IS NOT NULL;
