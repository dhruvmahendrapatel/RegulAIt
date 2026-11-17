-- ADR-0349 slice 2 (lane E30): the workflow start conflict policy. Hand-authored (never drizzle-kit generate).
-- Re-runnable.
--
-- `workflow_instances.work_item_ref`: the PM tool's key for the work item a start names (verbatim external id, at
-- most 200 characters). Null for every existing row, so no existing instance gains a start key.
ALTER TABLE "workflow_instances" ADD COLUMN IF NOT EXISTS "work_item_ref" text;
ALTER TABLE "workflow_instances" DROP CONSTRAINT IF EXISTS "workflow_instances_work_item_ref_check";
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_work_item_ref_check"
  CHECK ("work_item_ref" IS NULL OR char_length("work_item_ref") BETWEEN 1 AND 200);

-- The start key's uniqueness is the partial unique index
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_instances_open_start_uq" ON "workflow_instances"
--     ("template_ids", ("change"->>'targetSystem'), "work_item_ref") NULLS NOT DISTINCT
--     WHERE "work_item_ref" IS NOT NULL AND "status" NOT IN ('completed', 'aborted', 'denied', 'rolled_back')
-- built CONCURRENTLY (so a build never blocks workflow writes) by `runMigrations` from `CONCURRENT_INDEXES` in
-- `packages/db/src/migrate.ts`, after `migrate`, once this file's slug (or, after assign-at-merge, its tag) is journalled.
-- Every existing row has a null work_item_ref, so the build cannot meet a duplicate.

-- `org_settings.workflow_start_conflict_policy`: 'refuse' (default, ADR-0180) or 'use_existing', the audited,
-- step-up relaxation written through PUT /v1/org/settings.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "workflow_start_conflict_policy" text DEFAULT 'refuse' NOT NULL;
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_workflow_start_conflict_policy_check";
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_workflow_start_conflict_policy_check"
  CHECK ("workflow_start_conflict_policy" IN ('refuse', 'use_existing'));
