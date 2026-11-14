-- ADR-0289 (builder lane L6; ADR-0054 §3 "PM projects & work items"): the PM project / work-item importer.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `onboarding_imports.kind` gains `pm_work_items`, so every PM import (dry run, apply, refusal) is a row there,
--    like the user and group->role imports.
-- 2. `pm_project_initiatives`: one row per PM connection naming the Initiative its project rolls up to.
-- 3. `pm_imported_work_items`: LINKAGE to each existing work item found in a connection's project (pillar 8: the PM
--    tool is the source of truth, so no title, state or field is stored). A later import that no longer finds an
--    item sets `missing_since`; nothing is ever deleted by an import.
-- Nothing is backfilled.

ALTER TABLE "onboarding_imports" DROP CONSTRAINT IF EXISTS "onboarding_imports_kind_ck";
--> statement-breakpoint
ALTER TABLE "onboarding_imports" ADD CONSTRAINT "onboarding_imports_kind_ck" CHECK ("kind" IN ('users', 'group_roles', 'pm_work_items'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_project_initiatives" (
  "connection_id" uuid PRIMARY KEY NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "initiative_id" uuid NOT NULL REFERENCES "initiatives"("id") ON DELETE CASCADE,
  "import_id" uuid REFERENCES "onboarding_imports"("id") ON DELETE SET NULL,
  "mapped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_project_initiatives_initiative_idx" ON "pm_project_initiatives" ("initiative_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_imported_work_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "external_url" text NOT NULL,
  "item_type" text NOT NULL,
  "first_import_id" uuid REFERENCES "onboarding_imports"("id") ON DELETE SET NULL,
  "last_import_id" uuid REFERENCES "onboarding_imports"("id") ON DELETE SET NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "missing_since" timestamp with time zone,
  CONSTRAINT "pm_imported_work_items_external_id_check" CHECK (char_length("external_id") BETWEEN 1 AND 256),
  CONSTRAINT "pm_imported_work_items_external_url_check" CHECK (char_length("external_url") BETWEEN 1 AND 2048),
  CONSTRAINT "pm_imported_work_items_item_type_check" CHECK (char_length("item_type") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_imported_work_items_conn_ext_uq" ON "pm_imported_work_items" ("connection_id", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_imported_work_items_conn_id_idx" ON "pm_imported_work_items" ("connection_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_imported_work_items_first_import_idx" ON "pm_imported_work_items" ("first_import_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_imported_work_items_last_import_idx" ON "pm_imported_work_items" ("last_import_id");
