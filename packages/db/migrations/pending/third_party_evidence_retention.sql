-- ADR-0302 (ADR-0261 follow-up, backlog P37): a retention path for third-party ingest evidence. Hand-authored (never
-- drizzle-kit generate). Re-runnable: CREATE OR REPLACE only.
--
-- `third_party_ingest_records` stays append-only: UPDATE is always refused, TRUNCATE is still refused by its statement
-- trigger, and DELETE is refused EXCEPT a row the retention sweep is allowed to remove. The sweep sets the
-- transaction-local `regulait.tpi_retention_cutoff` to its cutoff (the compliance-cascade floor, ADR-0021, computed
-- from the database clock) and the guard lets a DELETE through only when:
--   - the setting parses as a timestamp,
--   - the cutoff is in the past by the DATABASE clock (`now()`), so a forged future cutoff deletes nothing new, and
--   - the row arrived before the cutoff (`received_at`, itself written by the database clock).
-- The 0142 `regulait.secret_reencrypt` pattern. It guards against an application path deleting evidence by mistake;
-- it is not a control against a database superuser, who can drop the trigger.
-- `third_party_ingest_record_findings` rows go with their record by its existing ON DELETE CASCADE.

CREATE OR REPLACE FUNCTION "third_party_ingest_records_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  raw text := coalesce(current_setting('regulait.tpi_retention_cutoff', true), '');
  cutoff timestamptz;
BEGIN
  IF TG_OP = 'DELETE' AND raw <> '' THEN
    BEGIN
      cutoff := raw::timestamptz;
    EXCEPTION WHEN others THEN
      cutoff := NULL;
    END;
    IF cutoff IS NOT NULL AND cutoff < now() AND OLD.received_at < cutoff THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'third_party_ingest_records rows are append-only third-party evidence (ADR-0261; only the ADR-0302 retention sweep may delete a row past its floor)' USING ERRCODE = 'check_violation';
END $$;
