-- ADR-0187 decisions 127-128 (PR #212 review follow-up): bounded model-artifact storage, and `clean`
-- refused for a scan with no format. Hand-authored (never drizzle-kit generate). 0175 is merged and is
-- not edited.
--
-- 1. Storage quotas and retention, strict by default (ADR-0180). Raising any of them is a relaxation
--    (a `settings_relax` step-up, audited). A quota counts every artifact row (its logical size), so
--    the same bytes uploaded twice count twice.
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_uploader_quota_megabytes" integer DEFAULT 2048 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_uploader_quota_count" integer DEFAULT 20 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_org_quota_megabytes" integer DEFAULT 20480 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_org_quota_count" integer DEFAULT 200 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_retention_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_uploader_quota_megabytes_check" CHECK ("model_artifact_uploader_quota_megabytes" BETWEEN 1 AND 1048576);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_uploader_quota_count_check" CHECK ("model_artifact_uploader_quota_count" BETWEEN 1 AND 100000);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_org_quota_megabytes_check" CHECK ("model_artifact_org_quota_megabytes" BETWEEN 1 AND 10485760);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_org_quota_count_check" CHECK ("model_artifact_org_quota_count" BETWEEN 1 AND 1000000);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_retention_days_check" CHECK ("model_artifact_retention_days" BETWEEN 1 AND 3650);
--> statement-breakpoint
-- the per-uploader quota sums by uploader
CREATE INDEX "model_artifacts_uploader_idx" ON "model_artifacts" ("uploaded_by_user_id");
--> statement-breakpoint
-- 2. Stored objects waiting to be deleted. A row is written in the SAME transaction that removes the
--    last artifact row naming the key (and, ahead of time, before an upload writes a new object, so a
--    crash between the write and the row leaves a record). The object is deleted only after that
--    commits, under the storage lock, and only while no artifact row names the key; a failed delete
--    keeps the row and the retention sweep retries it.
CREATE TABLE "model_artifact_object_deletions" (
  "storage_key" text PRIMARY KEY NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "not_before" timestamp with time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_error_code" text,
  CONSTRAINT "model_artifact_object_deletions_key_check" CHECK ("storage_key" ~ '^sha256/[0-9a-f]{64}$'),
  CONSTRAINT "model_artifact_object_deletions_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "model_artifact_object_deletions_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE INDEX "model_artifact_object_deletions_due_idx" ON "model_artifact_object_deletions" ("not_before");
--> statement-breakpoint
-- 3. PR #212 review [4235322386]: `"format" = 'safetensors'` is NULL, not false, for a NULL format,
--    so 0175's CHECK let a `clean` scan with no format through. The clean branch now fails explicitly
--    on NULL. A clean scan with no format was never valid (decision 105); none can exist on a first
--    load, and any that did reads `unknown` (never better), before the CHECK is replaced.
UPDATE "artifact_scans" SET "verdict" = 'unknown' WHERE "verdict" = 'clean' AND "format" IS NULL;
--> statement-breakpoint
ALTER TABLE "artifact_scans" DROP CONSTRAINT "artifact_scans_clean_format_check";
--> statement-breakpoint
ALTER TABLE "artifact_scans" ADD CONSTRAINT "artifact_scans_clean_format_check" CHECK ("verdict" <> 'clean' OR ("format" IS NOT NULL AND "format" = 'safetensors'));
