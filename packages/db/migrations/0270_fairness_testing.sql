-- ADR-0222 (P13(a)): fairness testing for a registered model (owner 2026-10-30, #453).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. Three org settings at their strict values (ADR-0180, a first load, nothing grandfathered): the feature OFF,
--    blocking ON, and a 30-day dataset retention (1..365). Turning the feature on, blocking off or a longer
--    retention is a `settings_relax` step-up through `PUT /v1/mrm/fairness/settings`.
-- 2. `fairness_datasets`: one uploaded, labelled evaluation dataset. Only the label, prediction and protected
--    attribute columns are kept, as JSON enveloped under the data key (`rows_ciphertext`, registered in
--    CIPHERTEXT_COLUMNS for the custody probe and the re-encryption walk). The ciphertext is set to NULL at the
--    retention date or on delete; the row, its sha256 and its runs stay for the audit trail. The purge CHECK makes
--    "rows kept" and "purged" exclusive.
-- 3. `fairness_runs`: one computation on one dataset against one model card, aggregates only (group counts and
--    rates, metric values, each threshold's verdict). A dataset referenced by a run is never deleted (RESTRICT).
-- No function and no trigger is added (the 0185 guard has nothing new to check).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_testing_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_block_on_fail" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_dataset_retention_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_fairness_dataset_retention_days_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_fairness_dataset_retention_days_check"
  CHECK ("fairness_dataset_retention_days" BETWEEN 1 AND 365);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "label_column" text NOT NULL,
  "prediction_column" text NOT NULL,
  "favourable_label" text NOT NULL,
  "protected_attributes" jsonb NOT NULL,
  "row_count" integer NOT NULL,
  "csv_bytes" integer NOT NULL,
  "csv_sha256" text NOT NULL,
  "rows_ciphertext" text,
  "expires_at" timestamp with time zone NOT NULL,
  "purged_at" timestamp with time zone,
  "purge_reason" text,
  "uploaded_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_datasets_row_count_check" CHECK ("row_count" BETWEEN 1 AND 100000),
  CONSTRAINT "fairness_datasets_csv_bytes_check" CHECK ("csv_bytes" BETWEEN 1 AND 5242880),
  CONSTRAINT "fairness_datasets_purge_check" CHECK (
    ("purged_at" IS NULL AND "purge_reason" IS NULL AND "rows_ciphertext" IS NOT NULL)
    OR ("purged_at" IS NOT NULL AND "purge_reason" IN ('retention', 'deleted') AND "rows_ciphertext" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_datasets_expires_idx" ON "fairness_datasets" ("expires_at")
  WHERE "rows_ciphertext" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fairness_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL REFERENCES "model_cards"("id") ON DELETE CASCADE,
  "dataset_id" uuid NOT NULL REFERENCES "fairness_datasets"("id") ON DELETE RESTRICT,
  "dataset_sha256" text NOT NULL,
  "metrics_version" text NOT NULL,
  "thresholds" jsonb NOT NULL,
  "min_group_size" integer NOT NULL,
  "result" jsonb NOT NULL,
  "outcome" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fairness_runs_outcome_check" CHECK ("outcome" IN ('pass', 'flag', 'fail', 'inconclusive')),
  CONSTRAINT "fairness_runs_min_group_size_check" CHECK ("min_group_size" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_runs_card_created_idx" ON "fairness_runs" ("card_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fairness_runs_dataset_idx" ON "fairness_runs" ("dataset_id");
