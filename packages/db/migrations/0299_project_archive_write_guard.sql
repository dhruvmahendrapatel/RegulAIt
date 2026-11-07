-- ADR-0206 G1: the database refuses a new member or a new shared-context revision on an archived project.
-- Hand-authored (never drizzle-kit generate). Re-runnable.
--
-- The gateway refuses these writes first (409 `project_archived`); this guard makes the archive hold for any writer
-- that reaches the tables another way. INSERT only: an archived project's existing rows are history and stay as they
-- are, and a project row can still be deleted by the paths that delete it today.
--
-- Concurrency: the archive takes FOR UPDATE on the project row, which conflicts with the FOR SHARE read below (and
-- with the KEY SHARE lock the foreign key takes), so an insert racing an archive either commits first (and the
-- archive then sees it) or waits and is refused.
--
-- search_path is pinned (migration 0185's invariant).

CREATE OR REPLACE FUNCTION "regulait_refuse_archived_project_write"() RETURNS trigger AS $$
DECLARE
  archived timestamp with time zone;
BEGIN
  SELECT p."archived_at" INTO archived FROM "projects" p WHERE p."id" = NEW."project_id" FOR SHARE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION '%: project % is archived; unarchive it before adding to it', TG_TABLE_NAME, NEW."project_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_members_archived_guard" ON "project_members";
--> statement-breakpoint
CREATE TRIGGER "project_members_archived_guard" BEFORE INSERT ON "project_members"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_archived_project_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_context_items_archived_guard" ON "project_context_items";
--> statement-breakpoint
CREATE TRIGGER "project_context_items_archived_guard" BEFORE INSERT ON "project_context_items"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_archived_project_write"();
