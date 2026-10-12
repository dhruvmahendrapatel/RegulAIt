-- ADR-0190 (batch 6 item 3) slice I2 — THE PLACEMENT DECISION: the columns I1 deferred (decision 14) and the
-- decision 8 invariant as a stored, checked property. Hand-authored (never drizzle-kit generate). Re-runnable: every
-- statement is idempotent.
--
-- 1. compliance_profiles.min_isolation_class (decision 7 item 3): a tag's isolation floor, composed MAX; NULL = no
--    opinion. Existing rows get NULL: no framework had an isolation opinion before this column existed, so nothing
--    is relaxed or grandfathered (ADR-0180).
-- 2. workload_identities.execution_profile_id (decision 8): the profile VERSION an agent's isolable workloads run
--    under; agent and builder-agent identities only. NULL = the shipped default for the workload kind.
-- 3. mcp_servers.execution_profile_id (decision 7 item 5, "the agent's or MCP server's own configured profile"):
--    stdio servers only. NULL = the shipped default.
-- 4. delegation_grants.required_isolation_class, execution_profile_digest (decision 8) and execution_placement_id
--    (decision 8 third bullet, amendment item 12). The guard trigger (migration 0184's body, unchanged otherwise)
--    gains: a child that names no class inherits its parent's, and one that names a LOWER class is refused (the
--    gateway refuses it first, `delegation-isolation`; this is the backstop). The digest is inherited the same way.
--    A grant that names a placement must name a class AT LEAST that placement's requirement (security review M1), the
--    placement belongs to one actor in one chain (every grant naming it has the same actor and root), and the placement
--    must be `placed`. The UPDATE branch already makes every column but revocation and spend immutable.
--
-- Adding a nullable column fires no trigger and rewrites no row.

-- ===== 1. compliance profiles ===================================================
ALTER TABLE "compliance_profiles" ADD COLUMN IF NOT EXISTS "min_isolation_class" text;
--> statement-breakpoint
ALTER TABLE "compliance_profiles" DROP CONSTRAINT IF EXISTS "compliance_profiles_min_isolation_class_check";
--> statement-breakpoint
-- never L0: a floor is at least a hardened container (decision 1)
ALTER TABLE "compliance_profiles" ADD CONSTRAINT "compliance_profiles_min_isolation_class_check" CHECK (
  "min_isolation_class" IS NULL OR "min_isolation_class" IN ('hardened_container', 'user_space_kernel', 'microvm')
);
--> statement-breakpoint

-- ===== 2. workload identities ===================================================
ALTER TABLE "workload_identities" ADD COLUMN IF NOT EXISTS "execution_profile_id" uuid REFERENCES "execution_profiles"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "workload_identities" DROP CONSTRAINT IF EXISTS "workload_identities_execution_profile_check";
--> statement-breakpoint
ALTER TABLE "workload_identities" ADD CONSTRAINT "workload_identities_execution_profile_check" CHECK (
  "execution_profile_id" IS NULL OR "kind" IN ('agent', 'builder_agent')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workload_identities_execution_profile_idx" ON "workload_identities" ("execution_profile_id") WHERE "execution_profile_id" IS NOT NULL;
--> statement-breakpoint

-- ===== 3. MCP servers ===========================================================
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "execution_profile_id" uuid REFERENCES "execution_profiles"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_execution_profile_check";
--> statement-breakpoint
-- a remote server runs on its own host and records `external`, never a class (decision 3)
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_execution_profile_check" CHECK (
  "execution_profile_id" IS NULL OR "transport" = 'stdio'
);
--> statement-breakpoint

-- ===== 4. delegation grants =====================================================
ALTER TABLE "delegation_grants" ADD COLUMN IF NOT EXISTS "required_isolation_class" text;
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD COLUMN IF NOT EXISTS "execution_profile_digest" text;
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD COLUMN IF NOT EXISTS "execution_placement_id" uuid REFERENCES "execution_placements"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "delegation_grants" DROP CONSTRAINT IF EXISTS "delegation_grants_isolation_check";
--> statement-breakpoint
ALTER TABLE "delegation_grants" ADD CONSTRAINT "delegation_grants_isolation_check" CHECK (
  ("required_isolation_class" IS NULL OR "required_isolation_class" IN ('hardened_container', 'user_space_kernel', 'microvm'))
  AND ("execution_profile_digest" IS NULL OR "execution_profile_digest" ~ '^[0-9a-f]{64}$')
  AND ("execution_placement_id" IS NULL OR "required_isolation_class" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_grants_execution_placement_idx" ON "delegation_grants" ("execution_placement_id") WHERE "execution_placement_id" IS NOT NULL;
--> statement-breakpoint
-- migration 0184's guard, with the decision 8 isolation rules added (marked ADR-0190). Everything else is as 0184
-- wrote it, including the search_path pinned by 0185.
CREATE OR REPLACE FUNCTION "regulait_delegation_grant_guard"() RETURNS trigger SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p "delegation_grants"%ROWTYPE;
  placement_outcome text;
  placement_class text;
  ranks constant text[] := ARRAY['hardened_container', 'user_space_kernel', 'microvm'];
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
  -- ADR-0190 decision 8: a grant that names a placement runs its workload there; the placement was placed, and
  -- its requirement is at least the grant's class
  IF NEW."execution_placement_id" IS NOT NULL THEN
    SELECT "outcome", "required_class" INTO placement_outcome, placement_class
      FROM "execution_placements" WHERE "id" = NEW."execution_placement_id";
    IF placement_outcome IS DISTINCT FROM 'placed' THEN
      RAISE EXCEPTION 'delegation_grants: a grant names only a placement that was placed (ADR-0190 decision 8)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- one actor in one chain per placement; serialised per placement so two inserts cannot both pass
    PERFORM pg_advisory_xact_lock(hashtext('execution_placement:' || NEW."execution_placement_id"::text));
    IF EXISTS (
      SELECT 1 FROM "delegation_grants" g
       WHERE g."execution_placement_id" = NEW."execution_placement_id"
         AND (g."actor_identity_id" <> NEW."actor_identity_id" OR g."root_grant_id" <> NEW."root_grant_id")
    ) THEN
      RAISE EXCEPTION 'delegation_grants: the placement holds another actor''s or another chain''s workload (ADR-0190 decision 8)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- migration 0184: an insert that names no depth limit gets the org limit (a root) or inherits its parent's,
  -- narrowed by the org limit (a child). It is never widened; the checks below still bind a stated one.
  -- A root's limit is never above the org's (S4 review): a stated one is clamped, a missing one is the org's.
  IF NEW."parent_grant_id" IS NULL THEN
    NEW."depth_limit" := LEAST(
      COALESCE(NEW."depth_limit", 8),
      8,
      COALESCE((SELECT "delegation_max_depth" FROM "org_settings" LIMIT 1), 3)
    );
    IF NEW."execution_placement_id" IS NOT NULL
       AND array_position(ranks, NEW."required_isolation_class") < array_position(ranks, placement_class) THEN
      RAISE EXCEPTION 'delegation_grants: a grant''s isolation class is at least its placement''s requirement (ADR-0190 decision 8, review M1)'
        USING ERRCODE = 'check_violation';
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
  -- ADR-0190 decision 8: a child never runs below its parent's isolation class. One that names none inherits the
  -- parent's class and profile digest; one that names a lower class is refused (not relaxable, decision 11).
  IF NEW."required_isolation_class" IS NULL THEN
    NEW."required_isolation_class" := p."required_isolation_class";
  END IF;
  IF NEW."execution_profile_digest" IS NULL THEN
    NEW."execution_profile_digest" := p."execution_profile_digest";
  END IF;
  IF p."required_isolation_class" IS NOT NULL
     AND array_position(ranks, NEW."required_isolation_class") < array_position(ranks, p."required_isolation_class") THEN
    RAISE EXCEPTION 'delegation_grants: a child is never below its parent''s isolation class (ADR-0190 decision 8, delegation-isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."execution_placement_id" IS NOT NULL
     AND array_position(ranks, NEW."required_isolation_class") < array_position(ranks, placement_class) THEN
    RAISE EXCEPTION 'delegation_grants: a grant''s isolation class is at least its placement''s requirement (ADR-0190 decision 8, review M1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
