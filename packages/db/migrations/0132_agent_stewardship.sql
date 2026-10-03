-- ADR-0168 amendment item 6 — agent stewardship: every agent is a non-human
-- identity with a named steward, a successor (so it is never orphaned when the
-- steward leaves), a lifecycle status and a review cadence.
--
-- The STEWARD is the ADR-0089 accountable owner — `owner_user_id`, unchanged.
-- A second "accountable human" column beside it would be two records of the
-- same fact that could disagree; the API names it `stewardUserId` and stores it
-- in the one column the inventory, posture, governance monitor and the
-- ADR-0159 remediation executor already read.
--
-- New here:
--   * `successor_user_id` — who takes over. Never the steward (CHECK below).
--     ON DELETE SET NULL for the same reason as the owner FK: users are
--     deactivated, never deleted, so the FK path is exceptional cleanup.
--   * `next_review_at` / `last_reviewed_at` / `last_reviewed_by_user_id` —
--     the review cadence. A recorded review sets the next one 6 months out when
--     a linked use case is high-risk (or prohibited), 12 months otherwise.
--     "Review overdue" and "orphaned" are computed at read time (ADR-0082
--     discipline): no stored flag an admin could set.
--   * the lifecycle vocabulary widens from active | deprecated | retired to
--     proposed | active | under_review | suspended | deprecated | retired.
--     `suspended` joins `retired` as out of service (dispatch refuses with a
--     named 409); proposed / under_review / deprecated warn only. The
--     ADR-0089 reason CHECK is unchanged: every non-active state carries one.
--   * the SoD pattern CHECK that pins lifecycle values follows the vocabulary.
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "successor_user_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "next_review_at" timestamp with time zone;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "last_reviewed_at" timestamp with time zone;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "last_reviewed_by_user_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_successor_user_id_fk"
    FOREIGN KEY ("successor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_last_reviewed_by_user_id_fk"
    FOREIGN KEY ("last_reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_successor_not_steward_ck";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_successor_not_steward_ck"
  CHECK ("successor_user_id" IS NULL OR "owner_user_id" IS NULL OR "successor_user_id" <> "owner_user_id");
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_lifecycle_status_ck";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_lifecycle_status_ck"
  CHECK ("lifecycle_status" IN ('proposed', 'active', 'under_review', 'suspended', 'deprecated', 'retired'));
--> statement-breakpoint
ALTER TABLE "sod_rule_sides" DROP CONSTRAINT IF EXISTS "sod_rule_sides_lifecycle_value_check";
--> statement-breakpoint
ALTER TABLE "sod_rule_sides" ADD CONSTRAINT "sod_rule_sides_lifecycle_value_check"
  CHECK ("pattern_dimension" <> 'lifecycle_status'
    OR "pattern_value" IN ('proposed', 'active', 'under_review', 'suspended', 'deprecated', 'retired'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_successor_user_id_idx" ON "agents" ("successor_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_next_review_at_idx" ON "agents" ("next_review_at");
