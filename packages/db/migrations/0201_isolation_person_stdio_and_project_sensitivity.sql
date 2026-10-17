-- ADR-0190 owner decisions C and D: a person's own stdio call relaxed to L2 per server or project, and the admin-set
-- project sensitivity. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- Owner decision D. A project's sensitivity for isolation is MAX(the strictest sensitivity of its AI use cases, this
-- field). The field can therefore only raise it. NULL = not set; a project with no use case and no field does not
-- resolve (`policy_unresolved`, owner decision B). Existing rows stay NULL (nothing is back-filled, ADR-0180).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "isolation_sensitivity" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_isolation_sensitivity_check"
    CHECK ("isolation_sensitivity" IS NULL OR "isolation_sensitivity" IN ('public', 'internal', 'confidential', 'regulated'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Owner decision C. An active row (cleared_at NULL) lowers the unknown-agent floor of an mcp_stdio call with NO agent,
-- made by a person in an interactive session, from L3 to L2, for one stdio MCP server or one project. Never org-wide:
-- there is no org scope. At most one active row per scope. No row exists by default (the strict default is L3).
-- scope_id has no foreign key on purpose: the row is evidence and must not block, or vanish with, its server or project.
CREATE TABLE IF NOT EXISTS "execution_person_stdio_relaxations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone,
  "cleared_by_user_id" uuid,
  CONSTRAINT "execution_person_stdio_relaxations_scope_kind_check" CHECK ("scope_kind" IN ('mcp_server', 'project')),
  CONSTRAINT "execution_person_stdio_relaxations_cleared_check" CHECK (("cleared_at" IS NULL) = ("cleared_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_person_stdio_relaxations_active_uq"
  ON "execution_person_stdio_relaxations" ("scope_kind", "scope_id") WHERE "cleared_at" IS NULL;
--> statement-breakpoint
-- never deleted; an UPDATE may only clear an active row, once, and change nothing else
-- (migration 0185's invariants: the function pins its search_path, and the table it guards refuses TRUNCATE)
CREATE OR REPLACE FUNCTION "execution_person_stdio_relaxations_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_person_stdio_relaxations rows are never deleted (ADR-0190 owner decision C)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."cleared_at" IS NOT NULL
     OR NEW."cleared_at" IS NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."scope_kind" IS DISTINCT FROM OLD."scope_kind"
     OR NEW."scope_id" IS DISTINCT FROM OLD."scope_id"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'an execution_person_stdio_relaxations row only gains its clearing, once (ADR-0190 owner decision C)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_person_stdio_relaxations_guard" ON "execution_person_stdio_relaxations";
--> statement-breakpoint
CREATE TRIGGER "execution_person_stdio_relaxations_guard" BEFORE UPDATE OR DELETE ON "execution_person_stdio_relaxations"
  FOR EACH ROW EXECUTE FUNCTION "execution_person_stdio_relaxations_guard"();
--> statement-breakpoint
-- a TRUNCATE skips every row trigger: refused that way too (0185's pattern)
DROP TRIGGER IF EXISTS "execution_person_stdio_relaxations_no_truncate" ON public."execution_person_stdio_relaxations";
--> statement-breakpoint
CREATE TRIGGER "execution_person_stdio_relaxations_no_truncate" BEFORE TRUNCATE ON public."execution_person_stdio_relaxations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
