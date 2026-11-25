-- ADR-0362 slice 1b-ii (lane E43): the per-project content-inspection setting. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent. The file name sorts after `content_extract_engine.sql`.
--
-- `project_content_inspection`: one row per project, gone with its project (ON DELETE CASCADE). No row is the shipped
-- default (off, `refuse`), so the table starts empty and no existing project changes. `updated_by` names the person
-- who last changed it (ON DELETE SET NULL). `on_uninspectable` is a closed vocabulary (CONTENT_INSPECTION_ON_UNINSPECTABLE
-- in @regulait/shared), not prose.
--
-- Row-level security: none yet, the same treatment as every other project-scoped table today (project_budgets and the
-- 31 tables ADR-0234 lists for batch 5, none of which has a policy yet). The table carries `project_id`, so by the
-- ADR-0234 appendix rule it joins batch 5 (project-scoped, keyed on project_members). The routes that read and write
-- it check project membership (GET) and admin (PUT) in the gateway, and the default privileges of migration 0272 grant
-- the runtime role on a new table.
-- No function or trigger is added, so the 0185 guard has nothing new to check.

CREATE TABLE IF NOT EXISTS "project_content_inspection" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "on_uninspectable" text DEFAULT 'refuse' NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_content_inspection_on_uninspectable_check" CHECK ("on_uninspectable" IN ('refuse', 'pass_not_scanned'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_content_inspection_updated_by_idx" ON "project_content_inspection" ("updated_by");
