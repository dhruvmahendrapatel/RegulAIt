-- ADR-0174 — enterprise sign-in through a brokered identity provider.
--
-- 1. `org_settings.local_sign_in`: 'enabled' (DEFAULT — today's behaviour) or
--    'break_glass_only'. In break-glass mode password sign-in is refused for
--    everyone except the admins listed in `break_glass_user_ids`. Distinct from
--    ADR-0025's `sso_only` (which refuses password login for everybody).
-- 2. `oidc_providers.broker_idps`: the upstream identity providers a BROKER
--    (Keycloak) offers through this OIDC client — any of microsoft, google,
--    github. NULL (DEFAULT) = an ordinary enterprise IdP. The sign-in page shows
--    one "Continue with …" button per entry and passes the broker an IdP hint.
-- 3. `oidc_providers.mfa_acr_values`: `acr` values that count as multi-factor
--    for this provider, in addition to the RFC 8176 `amr` values. NULL = amr only.
-- 4. `auth_sessions.idp_mfa`: true when the identity provider asserted MFA for
--    the login that minted the session. Such a session satisfies the org MFA
--    requirement without a RegulAIt TOTP enrolment.
-- 5. `federated_identities`: which (provider, subject) is linked to which user,
--    and how the link was made. Looked up BEFORE the email match on every
--    federated login.
-- 6. `federated_link_requests`: a federated identity that matched an existing
--    account holding a local credential. It links only after the person proves
--    the local account (password + TOTP) or an admin approves — never silently.
--
-- Additive and idempotent: every new column has a default that keeps the
-- pre-0139 behaviour, and no existing row changes meaning.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "local_sign_in" text DEFAULT 'enabled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_local_sign_in_ck";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_local_sign_in_ck"
  CHECK ("local_sign_in" IN ('enabled', 'break_glass_only'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "break_glass_user_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD COLUMN IF NOT EXISTS "broker_idps" jsonb;
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD COLUMN IF NOT EXISTS "mfa_acr_values" jsonb;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "idp_mfa" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "federated_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "oidc_provider_id" uuid REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "saml_provider_id" uuid REFERENCES "saml_providers"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "linked_via" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "federated_identities_one_provider_ck"
    CHECK (("oidc_provider_id" IS NULL) <> ("saml_provider_id" IS NULL)),
  CONSTRAINT "federated_identities_linked_via_ck"
    CHECK ("linked_via" IN ('preprovisioned', 'jit', 'proof', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federated_identities_oidc_subject_uq"
  ON "federated_identities" ("oidc_provider_id", "subject") WHERE "oidc_provider_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federated_identities_saml_subject_uq"
  ON "federated_identities" ("saml_provider_id", "subject") WHERE "saml_provider_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federated_identities_user_idx" ON "federated_identities" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "federated_link_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "oidc_provider_id" uuid REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "saml_provider_id" uuid REFERENCES "saml_providers"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "email" text NOT NULL,
  "idp_mfa" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "proof_token_hash" text,
  "proof_expires_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "federated_link_requests_one_provider_ck"
    CHECK (("oidc_provider_id" IS NULL) <> ("saml_provider_id" IS NULL)),
  CONSTRAINT "federated_link_requests_status_ck"
    CHECK ("status" IN ('pending', 'linked', 'approved', 'denied'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federated_link_requests_proof_token_uq"
  ON "federated_link_requests" ("proof_token_hash") WHERE "proof_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federated_link_requests_status_idx" ON "federated_link_requests" ("status");
