-- ADR-0206 G1: project archive. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. An archived project keeps every row it owns (spend, approvals, context, audit); it only stops taking new work.
--    `archived_at` NULL = active, which every existing row is: nothing is backfilled (ADR-0180, first load).
-- 2. Written only by `POST /v1/projects/:projectId/archive` and `/unarchive` (admin-only), in the same transaction as
--    the audit row. The reason and the actor are kept on the row so the project header can say who and why without
--    an audit query; the audit row stays the record.
-- 3. The CHECK keeps the three columns together: an archived project always says why, an active one carries no
--    stale reason or actor.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archived_reason" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archived_by_user_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_user_id_users_id_fk"
    FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_reason_check" CHECK (
    ("archived_at" IS NULL AND "archived_reason" IS NULL AND "archived_by_user_id" IS NULL)
    OR ("archived_at" IS NOT NULL AND "archived_reason" IS NOT NULL
        AND char_length(btrim("archived_reason")) BETWEEN 10 AND 500)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
