-- ADR-0208 (G7, #453 c6509969403): compliance profiles are edited through reviewed versions and can be retired.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `status` is active or retired. A retired profile is read-only: it takes no new version and no new carrier
--    (project, pending project, team or infrastructure resource). Its versions and history are kept, and the
--    audit-retention floor it set still counts (retentionFloor reads every profile), so retiring never shortens
--    audit retention.
-- 2. Retire is refused while any carrier holds the tag, so a retired profile never governs a live object.
-- 3. The CHECK ties the retired_* facts to the status in both directions. Nothing is backfilled: every existing
--    row is active (ADR-0180, a first load).
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "retired_by_user_id" uuid;

DO $$ BEGIN
  ALTER TABLE "compliance_profiles" ADD CONSTRAINT "compliance_profiles_retired_by_user_id_users_id_fk"
    FOREIGN KEY ("retired_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "compliance_profiles" ADD CONSTRAINT "compliance_profiles_status_check"
    CHECK ("status" IN ('active', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "compliance_profiles" ADD CONSTRAINT "compliance_profiles_retired_facts_check"
    CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL AND "retired_reason" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
