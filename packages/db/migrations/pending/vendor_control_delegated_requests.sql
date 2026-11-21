-- Pending migration vendor_control_delegated_requests (numbered at merge, ADR-0252). ADR-0338 slice 1c: connecting a
-- delegated (named admin) vendor control credential through the vendor's OAuth authorization-code flow with PKCE.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- `vendor_control_delegated_requests`: one sign-in an admin started, waiting for the vendor's redirect. The `state`
-- (single-use) and the nonce are kept server side, and so is the PKCE verifier, encrypted with the data key
-- (`code_verifier_ciphertext`, a CIPHERTEXT_COLUMNS envelope). The verifier never reaches the browser, so an
-- intercepted redirect cannot be redeemed. A request lives at most 10 minutes. It is spent once: `used_at` is set when
-- the callback consumes it, whatever the outcome.
--
-- The tenant, app, account and expiry the admin asked for are kept because the step-up at the start was bound to
-- them, and the callback stores exactly those. This is a commented 3NF exception: a point-in-time copy, never a live
-- reference. `replaces_credential_id` is the live control credential the admin named. The callback refuses when it
-- has moved since.
--
-- `vendor_control_delegated_requests_guard`: a row only gains `used_at`, once, and its verifier ciphertext is
-- destroyed at the same time. TRUNCATE is refused (the 0185 rules); the function is SECURITY INVOKER with a pinned
-- search_path. Row-level security is ENABLEd and FORCEd: an admin principal, or the `system_task` / `migration`
-- reason (the sweep). The 0272 default privileges give `regulait_app` its grants.

CREATE TABLE IF NOT EXISTS "vendor_control_delegated_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "nonce" text NOT NULL,
  "code_verifier_ciphertext" text,
  "tenant_id" text NOT NULL,
  "client_id" text NOT NULL,
  "account_upn" text NOT NULL,
  "expires_in_days" integer NOT NULL,
  "replaces_credential_id" uuid REFERENCES "discovery_credentials"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  CONSTRAINT "vendor_control_delegated_requests_state_uq" UNIQUE ("state"),
  CONSTRAINT "vendor_control_delegated_requests_state_check" CHECK ("state" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "vendor_control_delegated_requests_nonce_check" CHECK ("nonce" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "vendor_control_delegated_requests_ids_check" CHECK (
    "tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "client_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "vendor_control_delegated_requests_account_check" CHECK (char_length("account_upn") BETWEEN 3 AND 320 AND "account_upn" = lower("account_upn")),
  CONSTRAINT "vendor_control_delegated_requests_days_check" CHECK ("expires_in_days" BETWEEN 1 AND 90),
  CONSTRAINT "vendor_control_delegated_requests_expiry_check" CHECK ("expires_at" > "requested_at" AND "expires_at" <= "requested_at" + interval '10 minutes'),
  -- an unspent request holds its verifier; a spent one holds none
  CONSTRAINT "vendor_control_delegated_requests_verifier_check" CHECK (("used_at" IS NULL) = ("code_verifier_ciphertext" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_control_delegated_requests_source_idx" ON "vendor_control_delegated_requests" ("source_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_control_delegated_requests_expires_idx" ON "vendor_control_delegated_requests" ("expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "vendor_control_delegated_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."used_at" IS NOT NULL
     OR NEW."used_at" IS NULL
     OR NEW."code_verifier_ciphertext" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
     OR NEW."account_upn" IS DISTINCT FROM OLD."account_upn"
     OR NEW."expires_in_days" IS DISTINCT FROM OLD."expires_in_days"
     OR NEW."replaces_credential_id" IS DISTINCT FROM OLD."replaces_credential_id"
     OR NEW."redirect_uri" IS DISTINCT FROM OLD."redirect_uri"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'a vendor_control_delegated_requests row is spent once and only gains used_at (ADR-0338)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "vendor_control_delegated_requests_guard" ON "vendor_control_delegated_requests";
--> statement-breakpoint
CREATE TRIGGER "vendor_control_delegated_requests_guard" BEFORE UPDATE ON "vendor_control_delegated_requests"
  FOR EACH ROW EXECUTE FUNCTION "vendor_control_delegated_requests_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "vendor_control_delegated_requests_no_truncate" ON public."vendor_control_delegated_requests";
--> statement-breakpoint
CREATE TRIGGER "vendor_control_delegated_requests_no_truncate" BEFORE TRUNCATE ON public."vendor_control_delegated_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
ALTER TABLE "vendor_control_delegated_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "vendor_control_delegated_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "vendor_control_delegated_requests_admin" ON "vendor_control_delegated_requests";
--> statement-breakpoint
CREATE POLICY "vendor_control_delegated_requests_admin" ON "vendor_control_delegated_requests" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
