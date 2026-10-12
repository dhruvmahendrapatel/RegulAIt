-- ADR-0188 slice S7 (OWNER DECISION 8): the bearer workload secrets are retired. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent.
--
-- Engine runners and PDP clients now authenticate with `private_key_jwt` and DPoP-bound tokens from
-- `POST /oauth/token` (the `client_credentials` grant, for workload identities of kind `engine_runner` and `pdp`
-- only). Built as for a first load (ADR-0180): nothing is grandfathered and there is no warn-only phase.
--
-- 1. ENGINE RUNNERS. The `rge_` runner token (stored as `token_hash`) is gone. Every runner still live is revoked
--    here, so it must re-enrol with a key (its runs end through the lease sweep, which revokes their keys), and the
--    column and its unique constraint are dropped: no code path can resolve a runner from a bearer value again. A
--    runner's credential is now its workload identity's registered public key (`workload_credentials`).
--
-- 2. PDP VIRTUAL KEYS. Every live `pdp` virtual key is revoked here, and the purpose CHECK now admits `pdp` only on
--    a revoked row: the history of the keys that existed is kept, and no live one can be created or revived. A PDP
--    client is a workload identity of kind `pdp` with a registered key.
--
-- 3. WORKLOAD SELF TOKENS. A `client_credentials` token is the workload acting as itself on its own control-plane
--    route (the runner routes, or `POST /v1/authz/check`); it carries no delegation grant and no sponsor, so it can
--    never reach a governed route (the resource verifier for delegated tokens requires a grant). `issued_tokens`
--    records it with `subject_identity_id` and no `grant_id`: exactly one of the two, by CHECK, and a self token is
--    always DPoP-bound. Adding a nullable column fires no trigger and rewrites no row; the 0180 guard (only
--    revocation changes a row) covers the new column through its whole-row comparison.

-- ===== 1. engine runners: the runner token is retired ==========================
UPDATE "engine_runners"
  SET "revoked_at" = now(),
      "revoke_reason" = 'ADR-0188 S7: the bearer runner token was retired; the runner re-enrols with a key'
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "engine_runners" DROP CONSTRAINT IF EXISTS "engine_runners_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "engine_runners" DROP COLUMN IF EXISTS "token_hash";
--> statement-breakpoint

-- ===== 2. pdp virtual keys: revoked, and never live again =======================
UPDATE "virtual_keys" SET "revoked_at" = now() WHERE "purpose" = 'pdp' AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "virtual_keys" DROP CONSTRAINT IF EXISTS "virtual_keys_purpose_ck";
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_purpose_ck"
  CHECK ("purpose" IN ('dispatch', 'engine') OR ("purpose" = 'pdp' AND "revoked_at" IS NOT NULL));
--> statement-breakpoint

-- ===== 3. workload self tokens ================================================
ALTER TABLE "issued_tokens" ALTER COLUMN "grant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "issued_tokens" ADD COLUMN IF NOT EXISTS "subject_identity_id" uuid REFERENCES "workload_identities"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "issued_tokens" DROP CONSTRAINT IF EXISTS "issued_tokens_subject_check";
--> statement-breakpoint
ALTER TABLE "issued_tokens" ADD CONSTRAINT "issued_tokens_subject_check" CHECK (
  ("grant_id" IS NOT NULL AND "subject_identity_id" IS NULL)
  OR ("grant_id" IS NULL AND "subject_identity_id" IS NOT NULL AND "binding_kind" = 'dpop')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issued_tokens_subject_identity_idx" ON "issued_tokens" ("subject_identity_id") WHERE "subject_identity_id" IS NOT NULL;
