-- CXR-REV-002 (ADR-0047 addendum, 2026-11-22) — a report definition is ARCHIVED, never deleted. Hand-authored
-- (never drizzle-kit generate).
--
-- 1. `status` is the lifecycle `REPORT_DEFINITION_MACHINE` declares (active -> archived, final). Every existing row
--    is `active` by the column default: archiving is an explicit, audited act, so nothing is backfilled.
-- 2. `archived_at` is stamped exactly when the status is `archived` (CHECK), and `archived_by_user_id` is set only
--    with it. It is NULL for an archive by the identity-less bootstrap credential, and SET NULL with the user.
-- 3. The `report_schedules` and `report_runs` foreign keys keep ON DELETE CASCADE. No route deletes a definition any
--    more, so the cascade is never reached through the API; changing it would only break the test suites' own
--    cleanup. The runs are kept by the archive, not by the key.
-- 4. No function or trigger is added, so the 0185 search_path and TRUNCATE guards have nothing new to cover.

ALTER TABLE "report_definitions" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD COLUMN IF NOT EXISTS "archived_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "report_definitions" DROP CONSTRAINT IF EXISTS "report_definitions_status_ck";
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_status_ck" CHECK ("status" IN ('active', 'archived'));
--> statement-breakpoint
ALTER TABLE "report_definitions" DROP CONSTRAINT IF EXISTS "report_definitions_archived_check";
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_archived_check" CHECK (
  ("status" = 'archived') = ("archived_at" IS NOT NULL) AND ("archived_at" IS NOT NULL OR "archived_by_user_id" IS NULL)
);
