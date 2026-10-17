-- ADR-0190 I5 follow-up (review of #397): an execution profile can be REVERTED to an earlier live version, and then
-- versioned again. Hand-authored (never drizzle-kit generate). Re-runnable: one CREATE OR REPLACE.
--
-- A revert puts an earlier version back in force as itself (same row, same digest: the digest is the SHA-256 of the
-- body and unique, so a second row with that body cannot exist) and withdraws the versions above it by retiring them
-- one by one (the gateway does that; this guard always allowed retiring a row). Before this migration the guard refused
-- any new version once the NEWEST row was retired, so a reverted profile could never be versioned again. Now a new
-- version is refused only when NO version of the name is live (the profile itself was retired, as before). The version
-- number is still exactly the newest version + 1, under the same per-name lock; every other rule is unchanged.
CREATE OR REPLACE FUNCTION "regulait_execution_profile_guard"() RETURNS trigger AS $$
DECLARE
  latest integer;
  any_live boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_profiles: a profile version is never deleted (retire it)'
      USING ERRCODE = 'insufficient_privilege', HINT = 'placements and attestations name its digest (ADR-0190 decision 2)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- serialise versioning per name
    PERFORM pg_advisory_xact_lock(hashtext('execution_profiles:' || NEW."name"));
    SELECT "version" INTO latest
      FROM "execution_profiles" WHERE "name" = NEW."name" ORDER BY "version" DESC LIMIT 1;
    SELECT EXISTS (SELECT 1 FROM "execution_profiles" WHERE "name" = NEW."name" AND "retired_at" IS NULL) INTO any_live;
    IF NEW."version" <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'execution_profiles: % must be version %, not %', NEW."name", COALESCE(latest, 0) + 1, NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
    IF latest IS NOT NULL AND NOT any_live THEN
      RAISE EXCEPTION 'execution_profiles: % is retired; a retired profile is not versioned again', NEW."name"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'execution_profiles: a version is created live, then retired'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."digest" IS DISTINCT FROM OLD."digest"
     OR NEW."min_class" IS DISTINCT FROM OLD."min_class"
     OR NEW."shipped" IS DISTINCT FROM OLD."shipped"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."created_by" IS DISTINCT FROM OLD."created_by" AND NEW."created_by" IS NOT NULL) THEN
    RAISE EXCEPTION 'execution_profiles: a profile version is immutable (create version n+1)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at" THEN
    RAISE EXCEPTION 'execution_profiles: retirement is terminal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."retired_by" IS DISTINCT FROM OLD."retired_by" AND NEW."retired_by" IS NOT NULL
     AND NOT (OLD."retired_at" IS NULL AND NEW."retired_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'execution_profiles: retired_by is written with the retirement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
