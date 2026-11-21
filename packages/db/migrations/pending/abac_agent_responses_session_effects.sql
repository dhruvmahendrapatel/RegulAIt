-- ADR-0354 slice 2 — the session side effects of the graduated responses. Hand-authored (never drizzle-kit generate).
--
-- A `block_session` or `disable` policy response ends the calling agent's session by revoking its leaf delegation
-- grant (and, by the existing cascade, every grant under it). The revocation is recorded with its own reason code,
-- 'policy_response', so the grant's record says how it ended. This widens only the CHECK's vocabulary: every
-- existing row keeps a reason the CHECK already accepted. The vocabulary is migration 0188's plus the new code.

ALTER TABLE "delegation_grants" DROP CONSTRAINT IF EXISTS "delegation_grants_revoked_check";
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_revoked_check" CHECK (
  ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
  OR ("revoked_at" IS NOT NULL AND "revoked_reason" IS NOT NULL AND "revoked_reason" IN
      ('admin', 'cascade', 'identity_revoked', 'credential_revoked', 'sponsor_disabled', 'agent_halted', 'run_ended',
       'request_aborted', 'policy_response'))
);
