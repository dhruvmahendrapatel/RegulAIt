-- ADR-0188 (batch 6 item 1), the S5 security review (PR #302): items 5 and 6.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- Item 6: three org settings, all STRICT, written onto the existing org row by their column defaults (ADR-0180:
-- first load, no grandfathering). Relaxing any of them goes through the audited PUT /v1/org/settings with the
-- settings_relax step-up (the strictness registry reads packages/shared/src/identity/settings.ts):
--   delegation_uncapped_root_allowed      false  a root delegation grant with no cap is refused
--   delegation_root_default_cap_micros    0      none: the person must name a cap
--   delegation_root_max_lifetime_seconds  900    a root grant lives at most 15 minutes (also its default)
--
-- Item 5: a grant created for a token request that timed out is revoked in the creating transaction with the new
-- revocation reason 'request_aborted' (DELEGATION_REVOKE_REASONS).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "delegation_uncapped_root_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "delegation_root_default_cap_micros" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "delegation_root_max_lifetime_seconds" integer DEFAULT 900 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_delegation_root_default_cap_micros_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_delegation_root_default_cap_micros_check"
  CHECK ("delegation_root_default_cap_micros" BETWEEN 0 AND 1000000000000);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_delegation_root_max_lifetime_seconds_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_delegation_root_max_lifetime_seconds_check"
  CHECK ("delegation_root_max_lifetime_seconds" BETWEEN 60 AND 86400);
--> statement-breakpoint
-- the revocation vocabulary of migration 0180 plus 'request_aborted'
ALTER TABLE "delegation_grants" DROP CONSTRAINT IF EXISTS "delegation_grants_revoked_check";
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_revoked_check" CHECK (
  ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
  OR ("revoked_at" IS NOT NULL AND "revoked_reason" IS NOT NULL AND "revoked_reason" IN
      ('admin', 'cascade', 'identity_revoked', 'credential_revoked', 'sponsor_disabled', 'agent_halted', 'run_ended',
       'request_aborted'))
);
