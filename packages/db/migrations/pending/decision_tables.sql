-- ADR-0327 addendum (lane E12): business-authored decision tables. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. One guard function and its trigger (versions are frozen, below).
--   decision_tables          one table per AI step (agent + span name, the rule-step suggestion key), with a unique
--                            case-insensitive name. Nothing here changes routing: the AI still answers every request
--                            until the switch (ADR-0327 slice 4) is approved.
--   decision_table_versions  immutable versions. `body` is a schema-validated configuration document (ADR-0200
--                            exception), compiled by `compileDecisionTable` before insert. A version is created
--                            pending_review with an approvals row; only its reviewer's decision publishes it. At most
--                            one published and one pending version per table (partial unique indexes).
--                            `body_sha256` is the canonical-JSON digest of `body`; the approval carries the same
--                            digest, and publishing recomputes it and refuses on a mismatch. A BEFORE UPDATE trigger
--                            refuses any change to what was proposed (body, digest, table, version, base, author),
--                            so only the status, the approval link and the decision columns ever move. The author
--                            may only become NULL (the users FK's ON DELETE SET NULL).
-- RLS: deployment-wide configuration, admin-only routes (ADR-0234 appendix), like the rule-step tables.

CREATE TABLE IF NOT EXISTS "decision_tables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "step_name" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_tables_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "decision_tables_step_name_check" CHECK (char_length("step_name") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS "decision_tables_name_uq" ON "decision_tables" (lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "decision_tables_step_uq" ON "decision_tables" ("agent_id", "step_name");

CREATE TABLE IF NOT EXISTS "decision_table_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "table_id" uuid NOT NULL REFERENCES "decision_tables"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "body" jsonb NOT NULL,
  "body_sha256" text NOT NULL,
  "base_version" integer,
  "status" text DEFAULT 'pending_review' NOT NULL,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  CONSTRAINT "decision_table_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "decision_table_versions_body_sha256_check" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "decision_table_versions_status_check"
    CHECK ("status" IN ('pending_review', 'published', 'superseded', 'rejected', 'stale')),
  CONSTRAINT "decision_table_versions_decided_check" CHECK (("status" = 'pending_review') = ("decided_at" IS NULL))
);

COMMENT ON COLUMN "decision_table_versions"."body" IS
  'ADR-0200 exception: a schema-validated configuration document ({fields, rows}) as its author wrote it, immutable once written (ADR-0327 addendum)';

CREATE UNIQUE INDEX IF NOT EXISTS "decision_table_versions_version_uq" ON "decision_table_versions" ("table_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "decision_table_versions_one_published_uq" ON "decision_table_versions" ("table_id") WHERE "status" = 'published';
CREATE UNIQUE INDEX IF NOT EXISTS "decision_table_versions_one_pending_uq" ON "decision_table_versions" ("table_id") WHERE "status" = 'pending_review';
CREATE INDEX IF NOT EXISTS "decision_table_versions_approval_idx" ON "decision_table_versions" ("approval_id");

-- a version is what its reviewer approved: nothing that was proposed can change after insert
CREATE OR REPLACE FUNCTION public."decision_table_versions_freeze"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."body_sha256" IS DISTINCT FROM OLD."body_sha256"
     OR NEW."table_id" IS DISTINCT FROM OLD."table_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."base_version" IS DISTINCT FROM OLD."base_version"
     OR (NEW."author_user_id" IS DISTINCT FROM OLD."author_user_id" AND NEW."author_user_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'decision_table_versions: a proposed version is frozen; propose a new version instead (ADR-0327 addendum)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "decision_table_versions_freeze" ON public."decision_table_versions";
CREATE TRIGGER "decision_table_versions_freeze" BEFORE UPDATE ON public."decision_table_versions"
  FOR EACH ROW EXECUTE FUNCTION public."decision_table_versions_freeze"();

-- a TRUNCATE skips every row trigger: refused that way too (migration 0185's rule)
DROP TRIGGER IF EXISTS "decision_table_versions_no_truncate" ON public."decision_table_versions";
CREATE TRIGGER "decision_table_versions_no_truncate" BEFORE TRUNCATE ON public."decision_table_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
