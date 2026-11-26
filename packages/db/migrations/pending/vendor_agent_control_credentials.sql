-- Pending migration vendor_agent_control_credentials (numbered at merge, ADR-0252). ADR-0338 slice 1b: a source's
-- vendor CONTROL credential lives in `discovery_credentials` next to its read credential, told apart by a fixed
-- `purpose`. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `discovery_settings.vendor_agent_control_delegated_enabled`: the opt-in for a delegated (named admin) control
--    credential, default false (ADR-0180). Turning it on is a `settings_relax` step-up, audited; turning it off is free
--    and makes every delegated control credential unusable at once (`credential_mode_disabled`).
-- 2. `discovery_credentials.purpose`: `discovery_read` (every existing row, which behaves exactly as before) or
--    `platform_write`. Set at insert and never updated: the guard trigger below refuses a change.
-- 3. `discovery_credentials.credential_mode` gains `delegated`, allowed only on a `platform_write` row, which must then
--    carry `expires_at`, at most 90 days after it was stored, and a stored secret (the refresh token, encrypted with
--    the data key, destroyed on revoke by the existing check).
-- 4. A `platform_write` row keeps `write_scope = 'unverified'`: the scanner's read-only verification never runs on it.
-- 5. One live credential per source AND purpose: `discovery_credentials_live_uq` becomes (source_id, purpose).
-- 6. `discovery_credentials_guard`: a row's identity (source, purpose, mode, public config, expiry, creator) is fixed;
--    an update may only revoke it, record the read scanner's write-scope verdict, or replace its ciphertext (data-key
--    rotation, a delegated refresh token rotating on use). A revoked row is never revived.
--
-- The new function is SECURITY INVOKER with a pinned search_path, and the table refuses TRUNCATE beside the row guard
-- (the 0185 rules); the 0272 default privileges cover it. No table is added, so no row-level security changes.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "vendor_agent_control_delegated_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'discovery_read' NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "discovery_credentials" DROP CONSTRAINT IF EXISTS "discovery_credentials_purpose_check";
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD CONSTRAINT "discovery_credentials_purpose_check"
  CHECK ("purpose" IN ('discovery_read', 'platform_write'));
--> statement-breakpoint
ALTER TABLE "discovery_credentials" DROP CONSTRAINT IF EXISTS "discovery_credentials_mode_check";
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD CONSTRAINT "discovery_credentials_mode_check"
  CHECK ("credential_mode" IN ('federated', 'static', 'delegated'));
--> statement-breakpoint
ALTER TABLE "discovery_credentials" DROP CONSTRAINT IF EXISTS "discovery_credentials_delegated_check";
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD CONSTRAINT "discovery_credentials_delegated_check" CHECK (
  "credential_mode" <> 'delegated'
  OR ("purpose" = 'platform_write' AND "expires_at" IS NOT NULL AND "expires_at" <= "created_at" + interval '90 days'
      AND ("revoked_at" IS NOT NULL OR "secret_ciphertext" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "discovery_credentials" DROP CONSTRAINT IF EXISTS "discovery_credentials_expires_check";
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD CONSTRAINT "discovery_credentials_expires_check"
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at");
--> statement-breakpoint
ALTER TABLE "discovery_credentials" DROP CONSTRAINT IF EXISTS "discovery_credentials_write_purpose_scope_check";
--> statement-breakpoint
ALTER TABLE "discovery_credentials" ADD CONSTRAINT "discovery_credentials_write_purpose_scope_check"
  CHECK ("purpose" <> 'platform_write' OR "write_scope" = 'unverified');
--> statement-breakpoint
DROP INDEX IF EXISTS "discovery_credentials_live_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_credentials_live_uq"
  ON "discovery_credentials" ("source_id", "purpose") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "discovery_credentials_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."credential_mode" IS DISTINCT FROM OLD."credential_mode"
     OR NEW."public_config" IS DISTINCT FROM OLD."public_config"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by")) THEN
    RAISE EXCEPTION 'a discovery_credentials row only gains its revocation, its write-scope verdict or a re-encrypted secret (ADR-0338)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "discovery_credentials_guard" ON "discovery_credentials";
--> statement-breakpoint
CREATE TRIGGER "discovery_credentials_guard" BEFORE UPDATE ON "discovery_credentials"
  FOR EACH ROW EXECUTE FUNCTION "discovery_credentials_guard"();
--> statement-breakpoint
-- a TRUNCATE skips every row trigger: refused that way too (0185's pattern)
DROP TRIGGER IF EXISTS "discovery_credentials_no_truncate" ON public."discovery_credentials";
--> statement-breakpoint
CREATE TRIGGER "discovery_credentials_no_truncate" BEFORE TRUNCATE ON public."discovery_credentials"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
-- 7. `vendor_agent_actions.vendor_locator`: the vendor locator the control needs besides the agent id (Copilot Studio:
--    the Power Platform environment id), read from the discovered record's vendor attributes at request time. A
--    commented 3NF exception: part of the snapshot the approval's arguments digest binds; execute re-reads the record
--    and refuses when it moved.
ALTER TABLE "vendor_agent_actions" ADD COLUMN IF NOT EXISTS "vendor_locator" text;
--> statement-breakpoint
ALTER TABLE "vendor_agent_actions" DROP CONSTRAINT IF EXISTS "vendor_agent_actions_locator_check";
--> statement-breakpoint
ALTER TABLE "vendor_agent_actions" ADD CONSTRAINT "vendor_agent_actions_locator_check"
  CHECK ("vendor_locator" IS NULL OR char_length("vendor_locator") BETWEEN 1 AND 256);
