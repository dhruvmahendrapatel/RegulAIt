-- ADR-0182 (ADR-0175 batch D4) — D4 security review fix DFX1: the accountability
-- records survive the deletion of what they are ABOUT, and the append-only rule
-- admits only the referential actions it was written for.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785103000000.
--
-- Review finding (D4 gates review, low "append-only / cascade", latent): 0162's
-- `regulait_refuse_mutation()` admitted ANY UPDATE or DELETE issued from inside
-- any trigger (`pg_trigger_depth() > 1`), not only the foreign-key actions it
-- meant, and `use_case_decision_records.use_case_id` was ON DELETE CASCADE, so
-- deleting a use case silently removed the record of every decision on it.
--
-- 1. `use_case_decision_records.use_case_id` → ON DELETE SET NULL (and
--    nullable). A use case does not OWN the record of a decision taken on it:
--    the record outlives it, with `use_case_id` null. (The record's other
--    parents — workflow instance, approval, template, user — were already
--    SET NULL.) Incident events and clocks keep ON DELETE CASCADE from their
--    incident: the incident is their OWN parent, and an incident that is not
--    closed can no longer be deleted at all (3).
-- 2. `regulait_refuse_mutation()` is narrowed. Inside a referential action
--    (trigger depth > 1) it admits:
--      - an UPDATE that ONLY sets to NULL columns of this table's ON DELETE
--        SET NULL foreign keys (OLD and NEW are compared on every column);
--      - a DELETE only when the trigger names the record's OWN parent
--        (TG_ARGV: FK column, parent table) and that parent row is already
--        gone — i.e. the cascade of the parent's own deletion.
--    Everything else — a direct statement, or one nested in any other
--    trigger — is refused. A table whose trigger names no parent (decision
--    records, review-policy versions) never loses a row.
-- 3. `ai_incidents`: deleting an incident that is not closed is refused. A
--    closed incident may be deleted, and its events and clocks go with it
--    (2's own-parent cascade).
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180 §1): existing rows are not
-- touched; only constraints and triggers change. Like every application-layer
-- control here, a superuser can still disable a trigger.

CREATE OR REPLACE FUNCTION "regulait_refuse_mutation"() RETURNS trigger AS $$
DECLARE
  changed text[];
  set_null_cols text[];
  parent_gone boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'UPDATE' THEN
      -- every column whose value changed …
      SELECT COALESCE(array_agg(n.key), '{}') INTO changed
        FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
        WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
      -- … must be a column of an ON DELETE SET NULL foreign key of this table …
      SELECT COALESCE(array_agg(a.attname::text), '{}') INTO set_null_cols
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = TG_RELID AND c.contype = 'f' AND c.confdeltype = 'n';
      -- … and must now be NULL
      IF changed <@ set_null_cols
         AND NOT EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE to_jsonb(NEW) -> k <> 'null'::jsonb) THEN
        RETURN NEW;
      END IF;
    ELSIF TG_OP = 'DELETE' AND TG_NARGS = 2 THEN
      -- the cascade of the record's OWN parent: that parent row is already deleted
      EXECUTE format('SELECT NOT EXISTS (SELECT 1 FROM %I WHERE "id" = $1)', TG_ARGV[1])
        INTO parent_gone
        USING (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
      IF parent_gone THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'records here are evidence; write a new row instead (ADR-0182)';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 1. a decision record outlives its use case
ALTER TABLE "use_case_decision_records" DROP CONSTRAINT "use_case_decision_records_use_case_id_fkey";
--> statement-breakpoint
ALTER TABLE "use_case_decision_records" ALTER COLUMN "use_case_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "use_case_decision_records" ADD CONSTRAINT "use_case_decision_records_use_case_id_fkey"
  FOREIGN KEY ("use_case_id") REFERENCES "ai_use_cases"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- 2. the incident's own timeline and clocks go only with the incident itself
DROP TRIGGER "ai_incident_events_append_only" ON "ai_incident_events";
--> statement-breakpoint
CREATE TRIGGER "ai_incident_events_append_only"
  BEFORE UPDATE OR DELETE ON "ai_incident_events"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('incident_id', 'ai_incidents');
--> statement-breakpoint
DROP TRIGGER "ai_incident_notifications_never_deleted" ON "ai_incident_notifications";
--> statement-breakpoint
CREATE TRIGGER "ai_incident_notifications_never_deleted"
  BEFORE DELETE ON "ai_incident_notifications"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('incident_id', 'ai_incidents');
--> statement-breakpoint

-- 3. an incident that is not closed is never deleted
CREATE OR REPLACE FUNCTION "regulait_refuse_open_incident_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'closed' THEN
    RAISE EXCEPTION 'ai_incidents: an incident that is not closed cannot be deleted (% is %)', OLD."ref", OLD."status"
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'close the incident with its root cause and lessons learned first (ADR-0182)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ai_incidents_open_never_deleted"
  BEFORE DELETE ON "ai_incidents"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_open_incident_delete"();
