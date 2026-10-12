-- ADR-0188 S6 security review (PR #368). Hand-authored (never drizzle-kit generate). No row is read or written.
--
-- 1. Medium 2 — the grant proposals read one identity's governed DECISION rows of the last 30 days. The acting agent
--    is recorded in the actor columns from the audit v2 boundary on, and in `detail.delegation.actorIdentityId`
--    before it (ADR-0188 S4 amendment 5). Neither form had an index the query could range-scan by time, so every read
--    scanned the trail. Each index below is PARTIAL (decision rows naming an actor only) and leads on the identity,
--    then `at`. The query (`apps/gateway/src/oauth/identity-admin.ts`, `observedDecisions`) spells the same
--    predicates. CREATE INDEX, not CONCURRENTLY: the migrator applies pending files in one transaction (migrations
--    0154, 0155, 0167 and 0192 index `audit_log` the same way); building an index fires none of the append-only row
--    triggers.
--
-- 2. Low 5 — one key authenticates one identity, ever. A certificate credential now also records the RFC 7638
--    thumbprint of its PUBLIC KEY (`spki_thumbprint`), so the same key registered as a JWK on one identity and inside
--    a certificate on another is refused (the gateway checks both columns under an advisory lock; this index holds
--    the certificate side). Nullable, set only on new `x509` rows: an existing row is never rewritten (the 0180 guard
--    allows only revocation), and the column is not part of any earlier rule.

-- ===== 1. decision rows by acting identity and time ===========================
CREATE INDEX IF NOT EXISTS "audit_log_actor_decision_at_idx" ON "audit_log" ("actor_identity_id", "at")
  WHERE "actor_identity_id" IS NOT NULL AND ("detail" ->> 'receiptClass') = 'decision';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_legacy_actor_decision_at_idx" ON "audit_log" ((("detail" -> 'delegation') ->> 'actorIdentityId'), "at")
  WHERE "actor_identity_id" IS NULL AND "detail" ? 'delegation' AND ("detail" ->> 'receiptClass') = 'decision';
--> statement-breakpoint

-- ===== 2. a certificate credential's key thumbprint ===========================
ALTER TABLE "workload_credentials" ADD COLUMN IF NOT EXISTS "spki_thumbprint" text;
--> statement-breakpoint
ALTER TABLE "workload_credentials" ADD CONSTRAINT "workload_credentials_spki_thumbprint_check"
  CHECK ("spki_thumbprint" IS NULL OR ("kind" = 'x509' AND "spki_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workload_credentials_spki_thumbprint_uq" ON "workload_credentials" ("spki_thumbprint")
  WHERE "spki_thumbprint" IS NOT NULL;
