-- ADR-0327 slice 4d (lane E12): switching an AI step to a published decision table. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent. Sorts after `decision_tables` and `rule_step_switch`, which it
-- needs.
--   rule_step_switches  a request now switches one of two subjects: a detector suggestion (`suggestion_id`, slice 4a) or
--                       one published decision-table version (`decision_table_version_id`). Exactly one is set. The
--                       table is reached through the version (no copied table id), so one open request per table is
--                       held by the gateway under the `decision_tables` row lock, as the version set is.
--                       `rule_sha256` of a table switch is the version's `body_sha256`; the approval carries it too.
--                       The freeze trigger now covers the version column as well.
-- RLS: unchanged (deployment-wide configuration behind admin-only routes, ADR-0234 appendix).

ALTER TABLE "rule_step_switches" ADD COLUMN IF NOT EXISTS "decision_table_version_id" uuid
  REFERENCES "decision_table_versions"("id") ON DELETE CASCADE;
ALTER TABLE "rule_step_switches" ALTER COLUMN "suggestion_id" DROP NOT NULL;

ALTER TABLE "rule_step_switches" DROP CONSTRAINT IF EXISTS "rule_step_switches_subject_check";
ALTER TABLE "rule_step_switches" ADD CONSTRAINT "rule_step_switches_subject_check"
  CHECK (("suggestion_id" IS NULL) <> ("decision_table_version_id" IS NULL));

CREATE INDEX IF NOT EXISTS "rule_step_switches_version_requested_idx"
  ON "rule_step_switches" ("decision_table_version_id", "requested_at");

CREATE OR REPLACE FUNCTION public."rule_step_switches_freeze"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."suggestion_id" IS DISTINCT FROM OLD."suggestion_id"
     OR NEW."decision_table_version_id" IS DISTINCT FROM OLD."decision_table_version_id"
     OR NEW."rule_sha256" IS DISTINCT FROM OLD."rule_sha256"
     OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR (NEW."requested_by" IS DISTINCT FROM OLD."requested_by" AND NEW."requested_by" IS NOT NULL) THEN
    RAISE EXCEPTION 'rule_step_switches: a switch request is frozen; make a new request instead (ADR-0327)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
