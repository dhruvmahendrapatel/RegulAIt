-- ADR-0181 (strict defaults everywhere) — SA: identity and sessions.
--
-- Every default below flips to its strict value, and, as for a first load, the
-- existing rows are moved to it too. An admin may relax each one through its
-- existing audited write route (PUT /v1/org/settings, PATCH on the SAML / OIDC
-- provider).
--
-- org_settings.mfa_required               off   -> admins
-- org_settings.password_require_classes   2     -> 3
-- org_settings.session_idle_minutes       120   -> 30
-- org_settings.api_key_default_ttl_days   NULL  -> 90   (days; was "never")
-- org_settings.api_key_max_ttl_days       NULL  -> 365  (days; was "no ceiling")
-- org_settings.approval_delegation_enabled true -> false
-- saml_providers.want_authn_response_signed false -> true
-- oidc_providers                          JIT provisioning now REQUIRES a
--                                         non-empty allowed_email_domains list
--                                         (CHECK). A provider that had JIT on
--                                         with no list has JIT turned off: the
--                                         strict state, until an admin names
--                                         the domains.
--
-- Existing API keys keep the expiry they were issued with; the new default and
-- ceiling apply to keys issued from now on. Sessions keep the idle window they
-- snapshotted at creation (auth_sessions.idle_minutes).

ALTER TABLE "org_settings" ALTER COLUMN "mfa_required" SET DEFAULT 'admins';
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "password_require_classes" SET DEFAULT 3;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "session_idle_minutes" SET DEFAULT 30;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "api_key_default_ttl_days" SET DEFAULT 90;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "api_key_max_ttl_days" SET DEFAULT 365;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "approval_delegation_enabled" SET DEFAULT false;
--> statement-breakpoint
UPDATE "org_settings" SET
  "mfa_required" = 'admins',
  "password_require_classes" = 3,
  "session_idle_minutes" = 30,
  "api_key_default_ttl_days" = 90,
  "api_key_max_ttl_days" = 365,
  "approval_delegation_enabled" = false,
  "updated_at" = now();
--> statement-breakpoint
ALTER TABLE "saml_providers" ALTER COLUMN "want_authn_response_signed" SET DEFAULT true;
--> statement-breakpoint
UPDATE "saml_providers" SET "want_authn_response_signed" = true, "updated_at" = now()
  WHERE "want_authn_response_signed" = false;
--> statement-breakpoint
UPDATE "oidc_providers" SET "jit_provisioning" = false, "updated_at" = now()
  WHERE "jit_provisioning"
    AND NOT (CASE WHEN jsonb_typeof("allowed_email_domains") = 'array' THEN jsonb_array_length("allowed_email_domains") > 0 ELSE false END);
--> statement-breakpoint
ALTER TABLE "oidc_providers" DROP CONSTRAINT IF EXISTS "oidc_providers_jit_domains_ck";
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_jit_domains_ck" CHECK (
  NOT "jit_provisioning" OR (CASE WHEN jsonb_typeof("allowed_email_domains") = 'array' THEN jsonb_array_length("allowed_email_domains") > 0 ELSE false END)
);
