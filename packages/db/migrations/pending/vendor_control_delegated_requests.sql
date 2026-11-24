-- Pending migration vendor_control_delegated_requests (numbered at merge, ADR-0252). ADR-0338 slice 1c: connecting a
-- delegated (named admin) vendor control credential through the vendor's OAuth authorization-code flow with PKCE,
-- stored only once a second administrator approves it. Hand-authored (never drizzle-kit generate). Re-runnable: every
-- statement is idempotent.
--
-- `vendor_control_delegated_requests`: one sign-in an admin started. Its `status` is ADR-0348's
-- `vendor_control_delegated` machine (`VENDOR_CONTROL_DELEGATED_MACHINE`); the one CHECK listing the states is
-- `vendor_control_delegated_requests_status_check`.
--   awaiting_sign_in  -> awaiting_approval (sign_in), failed (sign_in_fail), cancelled, expired
--   awaiting_approval -> connected (approve), denied (deny), cancelled, expired
-- The state, nonce and PKCE verifier stay server side, the verifier encrypted with the data key, so an intercepted
-- redirect cannot be redeemed. The sign-in window is at most 10 minutes. After the sign-in the account's refresh token
-- is HELD encrypted here (`refresh_token_ciphertext`) until a second administrator, named at the start and never the
-- requester, approves it in the Approvals Queue; only then is the `discovery_credentials` row written. Every move
-- that leaves a state destroys what that state held, so a terminal row holds no secret.
--
-- The tenant, app, account and expiry the admin asked for are kept because the start step-up and the approval digest
-- are bound to them, and the approval stores exactly those: a commented 3NF exception, a point-in-time copy.
--
-- `vendor_control_delegated_requests_guard`: the identity is fixed; the account's object id and the approval are set
-- once; only the machine's own moves are allowed; a terminal row never changes. TRUNCATE is refused (the 0185 rules);
-- the function is SECURITY INVOKER with a pinned search_path. One open request per source (a partial unique index).
-- Row-level security is ENABLEd and FORCEd: an admin principal, or the `system_task` / `migration` reason. The 0272
-- default privileges give `regulait_app` its grants.

CREATE TABLE IF NOT EXISTS "vendor_control_delegated_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "approver_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'awaiting_sign_in' NOT NULL,
  "state" text NOT NULL,
  "nonce" text NOT NULL,
  "code_verifier_ciphertext" text,
  "refresh_token_ciphertext" text,
  "tenant_id" text NOT NULL,
  "client_id" text NOT NULL,
  "account_upn" text NOT NULL,
  "account_object_id" text,
  "expires_in_days" integer NOT NULL,
  "replaces_credential_id" uuid REFERENCES "discovery_credentials"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id"),
  "credential_id" uuid REFERENCES "discovery_credentials"("id") ON DELETE CASCADE,
  "outcome_code" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sign_in_expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_control_delegated_requests_state_uq" UNIQUE ("state"),
  CONSTRAINT "vendor_control_delegated_requests_status_check" CHECK ("status" IN ('awaiting_sign_in', 'awaiting_approval', 'connected', 'denied', 'failed', 'expired', 'cancelled')),
  CONSTRAINT "vendor_control_delegated_requests_state_check" CHECK ("state" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "vendor_control_delegated_requests_nonce_check" CHECK ("nonce" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "vendor_control_delegated_requests_ids_check" CHECK (
    "tenant_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "client_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND ("account_object_id" IS NULL OR "account_object_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  CONSTRAINT "vendor_control_delegated_requests_account_check" CHECK (char_length("account_upn") BETWEEN 3 AND 320 AND "account_upn" = lower("account_upn")),
  CONSTRAINT "vendor_control_delegated_requests_days_check" CHECK ("expires_in_days" BETWEEN 1 AND 90),
  CONSTRAINT "vendor_control_delegated_requests_window_check" CHECK ("sign_in_expires_at" > "requested_at" AND "sign_in_expires_at" <= "requested_at" + interval '10 minutes'),
  -- four eyes: the approver is never the requester
  CONSTRAINT "vendor_control_delegated_requests_two_people_check" CHECK ("approver_user_id" <> "requested_by"),
  -- the verifier lives only while the sign-in is awaited; the held refresh token only while the approval is
  CONSTRAINT "vendor_control_delegated_requests_verifier_check" CHECK (("status" = 'awaiting_sign_in') = ("code_verifier_ciphertext" IS NOT NULL)),
  CONSTRAINT "vendor_control_delegated_requests_held_token_check" CHECK (("status" = 'awaiting_approval') = ("refresh_token_ciphertext" IS NOT NULL)),
  CONSTRAINT "vendor_control_delegated_requests_signed_in_check" CHECK (
    ("status" <> 'awaiting_sign_in' OR ("account_object_id" IS NULL AND "approval_id" IS NULL))
    AND ("status" NOT IN ('awaiting_approval', 'connected') OR ("account_object_id" IS NOT NULL AND "approval_id" IS NOT NULL))
  ),
  CONSTRAINT "vendor_control_delegated_requests_connected_check" CHECK (("status" = 'connected') = ("credential_id" IS NOT NULL)),
  CONSTRAINT "vendor_control_delegated_requests_outcome_check" CHECK ("outcome_code" IS NULL OR "outcome_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_control_delegated_requests_open_uq" ON "vendor_control_delegated_requests" ("source_id")
  WHERE "status" IN ('awaiting_sign_in', 'awaiting_approval');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_control_delegated_requests_source_idx" ON "vendor_control_delegated_requests" ("source_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_control_delegated_requests_approval_idx" ON "vendor_control_delegated_requests" ("approval_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "vendor_control_delegated_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."status" IN ('connected', 'denied', 'failed', 'expired', 'cancelled')
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."approver_user_id" IS DISTINCT FROM OLD."approver_user_id"
     OR NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."nonce" IS DISTINCT FROM OLD."nonce"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
     OR NEW."account_upn" IS DISTINCT FROM OLD."account_upn"
     OR NEW."expires_in_days" IS DISTINCT FROM OLD."expires_in_days"
     OR NEW."replaces_credential_id" IS DISTINCT FROM OLD."replaces_credential_id"
     OR NEW."redirect_uri" IS DISTINCT FROM OLD."redirect_uri"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR NEW."sign_in_expires_at" IS DISTINCT FROM OLD."sign_in_expires_at"
     OR (OLD."account_object_id" IS NOT NULL AND NEW."account_object_id" IS DISTINCT FROM OLD."account_object_id")
     OR (OLD."approval_id" IS NOT NULL AND NEW."approval_id" IS DISTINCT FROM OLD."approval_id")
     -- only the machine's own moves (VENDOR_CONTROL_DELEGATED_MACHINE)
     OR NOT (
       (OLD."status" = 'awaiting_sign_in' AND NEW."status" IN ('awaiting_approval', 'failed', 'cancelled', 'expired'))
       OR (OLD."status" = 'awaiting_approval' AND NEW."status" IN ('connected', 'denied', 'cancelled', 'expired'))
     ) THEN
    RAISE EXCEPTION 'a vendor_control_delegated_requests row moves only along its machine, keeps its identity, and never changes once final (ADR-0338)' USING ERRCODE = 'check_violation';
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
