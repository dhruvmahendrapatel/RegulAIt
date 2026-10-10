-- ADR-0188 slice S4 (security review of S3, PR #279): store the decision 23 `max_depth` so a child can never
-- delegate deeper than its parent authorised. Hand-authored (never drizzle-kit generate).
--
-- `depth_limit` is ABSOLUTE: the deepest stored `depth` any grant in this subtree may have. A root gets the org's
-- `delegation_max_depth`; a child gets min(parent.depth_limit, child.depth + max_depth). Admission refuses when
-- parent.depth + 1 > parent.depth_limit; the guard trigger below refuses the same at the database.
--
-- Existing rows: nothing is grandfathered (ADR-0180). The product is not live; any row already present gets the
-- org limit (never less than its own depth), which is exactly what admission enforced before this column existed.
-- The column has no column DEFAULT (it depends on the org row and the parent): the guard trigger fills a missing
-- value with the org limit for a root, or min(parent.depth_limit, org limit) for a child. Product code always states
-- it (`delegation.ts`); the fill exists so no path can create an unlimited grant by omission.
ALTER TABLE "delegation_grants" ADD COLUMN "depth_limit" integer;
--> statement-breakpoint
ALTER TABLE "delegation_grants" DISABLE TRIGGER "delegation_grants_guard";
--> statement-breakpoint
UPDATE "delegation_grants" SET "depth_limit" = GREATEST("depth", LEAST(8, COALESCE((SELECT "delegation_max_depth" FROM "org_settings" LIMIT 1), 3)));
--> statement-breakpoint
ALTER TABLE "delegation_grants" ENABLE TRIGGER "delegation_grants_guard";
--> statement-breakpoint
ALTER TABLE "delegation_grants" ALTER COLUMN "depth_limit" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_depth_limit_check" CHECK ("depth_limit" BETWEEN "depth" AND 8);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regulait_delegation_grant_guard"() RETURNS trigger AS $$
DECLARE
  p "delegation_grants"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delegation_grants: a grant is never deleted (revoke it)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_reason', 'settled_micros', 'reserved_micros'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_reason', 'settled_micros', 'reserved_micros']) THEN
      RAISE EXCEPTION 'delegation_grants: a grant changes only by revocation or spend (ADR-0188 decision 4)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."revoked_at" IS NOT NULL
       AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason") THEN
      RAISE EXCEPTION 'delegation_grants: a revocation is never undone or rewritten'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT
  -- migration 0184: an insert that names no depth limit gets the org limit (a root) or inherits its parent's,
  -- narrowed by the org limit (a child). It is never widened; the checks below still bind a stated one.
  IF NEW."parent_grant_id" IS NULL THEN
    IF NEW."depth_limit" IS NULL THEN
      NEW."depth_limit" := LEAST(8, COALESCE((SELECT "delegation_max_depth" FROM "org_settings" LIMIT 1), 3));
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM "delegation_grants" WHERE "id" = NEW."parent_grant_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delegation_grants: parent % does not exist', NEW."parent_grant_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."path" IS DISTINCT FROM (p."path" || p."id")
     OR NEW."depth" <> p."depth" + 1
     OR NEW."root_grant_id" IS DISTINCT FROM p."root_grant_id" THEN
    RAISE EXCEPTION 'delegation_grants: path, depth and root must follow the parent row (ADR-0188 decision 17)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sponsor_user_id" IS DISTINCT FROM p."sponsor_user_id"
     OR NEW."project_id" IS DISTINCT FROM p."project_id"
     OR NEW."environment" IS DISTINCT FROM p."environment"
     OR NEW."run_id" IS DISTINCT FROM p."run_id"
     OR NEW."builder_turn_id" IS DISTINCT FROM p."builder_turn_id"
     OR NEW."engine_run_id" IS DISTINCT FROM p."engine_run_id"
     OR NEW."schedule_id" IS DISTINCT FROM p."schedule_id" THEN
    RAISE EXCEPTION 'delegation_grants: sponsor, project, environment and run context are immutable down the chain (ADR-0188 decision 17)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."depth_limit" IS NULL THEN
    NEW."depth_limit" := LEAST(p."depth_limit", 8, COALESCE((SELECT "delegation_max_depth" FROM "org_settings" LIMIT 1), 3));
  END IF;
  -- ADR-0188 S4 (migration 0184): the parent's absolute depth limit binds every descendant
  IF NEW."depth" > p."depth_limit" OR NEW."depth_limit" > p."depth_limit" THEN
    RAISE EXCEPTION 'delegation_grants: a child is deeper than, or allows deeper than, its parent''s depth limit (ADR-0188 decision 23)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expires_at" > p."expires_at" THEN
    RAISE EXCEPTION 'delegation_grants: a child never outlives its parent (ADR-0188 decision 4)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p."cap_micros" IS NOT NULL AND (NEW."cap_micros" IS NULL OR NEW."cap_micros" > p."cap_micros") THEN
    RAISE EXCEPTION 'delegation_grants: a child of a capped grant has a cap no larger than its parent''s (ADR-0188 decision 22)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- ADR-0188 decision 19 (slice S4): once the v2 boundary exists, the DATABASE refuses an audit row at or past it
-- that does not say `chain_version = 2`. This is the refusal a v1-only writer meets (a binary older than S1, a
-- raw client): it cannot land a v1 row past the boundary even if it was never drained. A row below the boundary
-- (or with no seq: never written by the chained writer) is untouched.
CREATE OR REPLACE FUNCTION "regulait_audit_v2_floor"() RETURNS trigger AS $$
DECLARE
  boundary bigint;
BEGIN
  SELECT min("from_seq") INTO boundary FROM "audit_chain_versions" WHERE "version" = 2;
  IF boundary IS NOT NULL AND NEW."seq" IS NOT NULL AND NEW."seq" >= boundary
     AND NEW."chain_version" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'audit_log: seq % is past the v2 boundary % and must be written as chain_version 2 (ADR-0188 decision 19)', NEW."seq", boundary
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_log_v2_floor"
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "regulait_audit_v2_floor"();
