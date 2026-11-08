-- Pending migration drift_ingest_credentials (ADR-0252: numbered at merge). ADR-0223 amendment 1 (P13b follow-up from the #628 security review): a scoped, write-only
-- ingestion credential per drift monitor, so a pipeline no longer pushes production summaries with an admin API key.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
--   model_drift_ingest_credentials  one credential bound to ONE monitor. It opens exactly one route
--                                   (POST /v1/model-drift/ingest/:monitorId/reports) for that monitor and nothing
--                                   else. Only the SHA-256 of the `rgldi_` token is stored (the shared `hashToken`
--                                   scheme; 256 bits of randomness, so no salt or work factor). It always expires
--                                   (NOT NULL, at most 365 days after issue, CHECK-capped) and is revoked by setting
--                                   `revoked_at`; nothing else in the row changes after issue except `last_used_at`.
--                                   Rotation issues a new row (`replaces_id`) and revokes the old one in the same
--                                   transaction, so `created_at` is the time the secret was set.
--   model_drift_reports             gains `ingest_credential_id` (which credential pushed it; NULL for an admin's
--                                   upload or push) and `idempotency_key` (the replay guard: one key records one
--                                   report per monitor; set by the gateway only on a credential push).
--
-- No row here = no credential = the ingestion route refuses everything (ADR-0180: off unless a monitor issues one).
-- Every write goes through the gateway in the same transaction as its audit row. No function and no trigger is
-- created here, so the 0185 guard has nothing new to check. Single-tenant deployment: no tenant column for RLS.

CREATE TABLE IF NOT EXISTS "model_drift_ingest_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "monitor_id" uuid NOT NULL REFERENCES "model_drift_monitors"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "replaces_id" uuid REFERENCES "model_drift_ingest_credentials"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "model_drift_ingest_credentials_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "model_drift_ingest_credentials_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "model_drift_ingest_credentials_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_drift_ingest_credentials_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '365 days'),
  CONSTRAINT "model_drift_ingest_credentials_revoked_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_drift_ingest_credentials_monitor_idx" ON "model_drift_ingest_credentials" ("monitor_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "model_drift_reports" ADD COLUMN IF NOT EXISTS "ingest_credential_id" uuid REFERENCES "model_drift_ingest_credentials"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "model_drift_reports" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "model_drift_reports" ADD CONSTRAINT "model_drift_reports_idempotency_check"
    CHECK ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 16 AND 128);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_drift_reports_idempotency_uq" ON "model_drift_reports" ("monitor_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
