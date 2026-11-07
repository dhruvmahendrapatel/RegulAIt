-- ADR-0240: one second factor (TOTP) for the two external portals, the supplier portal (ADR-0221) and the auditor
-- portal (ADR-0225). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. Two org settings, both shipped ON (ADR-0180): `supplier_portal_mfa_required` and `trust_auditor_mfa_required`.
--    While on, a spent single-use link opens no session by itself: the person must enrol (first use) or present a
--    TOTP code. Turning either off is a relaxation (settings_relax step-up, audited).
-- 2. `external_mfa_factors`: one TOTP factor per external grant. Exactly one of the two grant references is set, so
--    the portal is the reference that is set, never a copied column. The secret is a data-key envelope
--    (`CIPHERTEXT_COLUMNS`). A factor locks after repeated wrong codes and only the inviting side (an admin) can
--    reset it: there is no self-service recovery. A reset deletes the row (the audit row is the record).
-- 3. `external_mfa_challenges`: the short step between a spent link and a session. Only the sha256 of its token is
--    stored; it lives at most 15 minutes and is spent on the first correct code. It names the link that was spent,
--    so the session it becomes still records which link opened it.
-- Every timestamp here is on the database clock (`now()`).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "supplier_portal_mfa_required" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "trust_auditor_mfa_required" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_mfa_factors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "supplier_access_id" uuid REFERENCES "supplier_access"("id") ON DELETE CASCADE,
  "auditor_grant_id" uuid REFERENCES "auditor_grants"("id") ON DELETE CASCADE,
  "secret_ciphertext" text NOT NULL,
  "activated_at" timestamp with time zone,
  "last_used_step" bigint,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "locked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_mfa_factors_supplier_access_uq" UNIQUE ("supplier_access_id"),
  CONSTRAINT "external_mfa_factors_auditor_grant_uq" UNIQUE ("auditor_grant_id"),
  CONSTRAINT "external_mfa_factors_one_grant_check" CHECK (num_nonnulls("supplier_access_id", "auditor_grant_id") = 1),
  CONSTRAINT "external_mfa_factors_failed_check" CHECK ("failed_attempts" BETWEEN 0 AND 100),
  CONSTRAINT "external_mfa_factors_secret_check" CHECK (char_length("secret_ciphertext") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_mfa_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "factor_id" uuid NOT NULL REFERENCES "external_mfa_factors"("id") ON DELETE CASCADE,
  "supplier_invitation_id" uuid REFERENCES "supplier_invitations"("id") ON DELETE CASCADE,
  "auditor_link_id" uuid REFERENCES "auditor_links"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "external_mfa_challenges_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "external_mfa_challenges_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "external_mfa_challenges_one_link_check" CHECK (num_nonnulls("supplier_invitation_id", "auditor_link_id") = 1),
  CONSTRAINT "external_mfa_challenges_ttl_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '15 minutes'
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_mfa_challenges_factor_idx" ON "external_mfa_challenges" ("factor_id");
--> statement-breakpoint
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0296_external_portal_mfa',
  'org_settings',
  NULL,
  'external-portal-mfa-strict',
  'Migration 0296 introduced a required second factor (TOTP) for the supplier portal and the auditor portal at the ' ||
    'STRICT value (required): a single-use link alone no longer opens a session. Relaxing either is audited, with a step-up.',
  jsonb_build_object('phase', 'migration-0296', 'settings', jsonb_build_object(
    'supplierPortalMfaRequired', "supplier_portal_mfa_required",
    'trustAuditorMfaRequired', "trust_auditor_mfa_required"))
FROM "org_settings";
