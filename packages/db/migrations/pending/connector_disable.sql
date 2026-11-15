-- ADR-0207 (G3) — a connector can be disabled, enabled again and deleted. Hand-authored (never drizzle-kit generate).
--
-- 1. Three nullable columns. NULL `disabled_at` = enabled, which every existing row stays: disabling is an explicit,
--    audited act, so nothing is backfilled (ADR-0180 applies to new objects; an existing connector keeps serving).
-- 2. The reason is required with the stamp and bounded (10 to 1000 characters), repeating the route's refusal, so a
--    row written around the API cannot disable without saying why. `disabled_by` is SET NULL with the user.
-- 3. No new trigger: 0122's statement-level `connectors_policy_epoch` already advances the policy epoch on every
--    UPDATE, so an in-flight call decided before the disable is withheld at its next epoch check.
-- 4. `disabled_reason` is operator prose, registered in prose-scrub.ts (ADR-0102).

ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "disabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT IF EXISTS "connectors_disabled_check";
--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_disabled_check" CHECK (
  ("disabled_at" IS NULL AND "disabled_reason" IS NULL AND "disabled_by" IS NULL)
  OR ("disabled_at" IS NOT NULL AND char_length("disabled_reason") BETWEEN 10 AND 1000)
);
