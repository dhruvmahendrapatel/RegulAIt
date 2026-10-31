-- ADR-0208 G9: lifecycle for the libraries (retire an eval dataset, retire a red-team library version, edit and
-- soft-delete an engine schedule, cancel a certification campaign).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. Nothing is backfilled: every existing row stays active / not deleted / not cancelled (the columns are NULL).
-- 2. Each state carries who, when and why. The *_reason columns are registered in the prose scrub
--    (packages/db/src/prose-scrub.ts). The actor FKs are ON DELETE SET NULL so a removed person never removes history.
-- 3. The CHECKs keep each state whole: a retired/cancelled row always has its time and reason, and an active one has
--    neither. The gateway writes these only in the same transaction as the action's audit row.

-- ---- eval datasets: retired BY NAME (every version of the name carries the stamp) ------------------------------
ALTER TABLE "eval_datasets" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "eval_datasets" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "eval_datasets" ADD COLUMN IF NOT EXISTS "retired_by_user_id" uuid;
DO $$ BEGIN
  ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_retired_by_fk"
    FOREIGN KEY ("retired_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_retired_check" CHECK (
    ("retired_at" IS NULL) = ("retired_reason" IS NULL)
    AND ("retired_reason" IS NULL OR length(btrim("retired_reason")) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- red-team libraries: one VERSION retires; status gains 'retired' --------------------------------------------
ALTER TABLE "redteam_libraries" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "redteam_libraries" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "redteam_libraries" ADD COLUMN IF NOT EXISTS "retired_by_user_id" uuid;
DO $$ BEGIN
  ALTER TABLE "redteam_libraries" ADD CONSTRAINT "redteam_libraries_retired_by_fk"
    FOREIGN KEY ("retired_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "redteam_libraries" DROP CONSTRAINT IF EXISTS "redteam_libraries_status_ck";
ALTER TABLE "redteam_libraries" ADD CONSTRAINT "redteam_libraries_status_ck"
  CHECK ("status" IN ('draft', 'published', 'retired'));
DO $$ BEGIN
  ALTER TABLE "redteam_libraries" ADD CONSTRAINT "redteam_libraries_retired_check" CHECK (
    ("status" = 'retired') = ("retired_at" IS NOT NULL)
    AND ("retired_at" IS NULL) = ("retired_reason" IS NULL)
    AND ("retired_reason" IS NULL OR length(btrim("retired_reason")) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- engine schedules: soft delete ------------------------------------------------------------------------------
ALTER TABLE "engine_schedules" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "engine_schedules" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" uuid;
DO $$ BEGIN
  ALTER TABLE "engine_schedules" ADD CONSTRAINT "engine_schedules_deleted_by_fk"
    FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- a deleted schedule is never due: the sweep's partial index leaves it out
DROP INDEX IF EXISTS "engine_schedules_due_idx";
CREATE INDEX IF NOT EXISTS "engine_schedules_due_idx" ON "engine_schedules" ("next_run_at")
  WHERE "enabled" AND "deleted_at" IS NULL;

-- ---- certification campaigns: cancel ----------------------------------------------------------------------------
ALTER TABLE "grant_certification_campaigns" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
ALTER TABLE "grant_certification_campaigns" ADD COLUMN IF NOT EXISTS "cancelled_reason" text;
ALTER TABLE "grant_certification_campaigns" ADD COLUMN IF NOT EXISTS "cancelled_by_user_id" uuid;
DO $$ BEGIN
  ALTER TABLE "grant_certification_campaigns" ADD CONSTRAINT "grant_cert_campaigns_cancelled_by_fk"
    FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "grant_certification_campaigns" DROP CONSTRAINT IF EXISTS "grant_cert_campaigns_status_check";
ALTER TABLE "grant_certification_campaigns" ADD CONSTRAINT "grant_cert_campaigns_status_check"
  CHECK ("status" IN ('open', 'completed', 'cancelled'));
DO $$ BEGIN
  ALTER TABLE "grant_certification_campaigns" ADD CONSTRAINT "grant_cert_campaigns_cancelled_check" CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_reason" IS NULL)
    AND ("cancelled_reason" IS NULL OR length(btrim("cancelled_reason")) > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
