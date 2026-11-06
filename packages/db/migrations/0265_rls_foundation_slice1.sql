-- ADR-0234 (PENDING S7, ADR-0200 checklist item 14, ADR-0060 follow-up 6): row-level security, slice 1.
--
-- What this migration does, in order:
--   1. the non-owner runtime role `regulait_app` (NOLOGIN group role) and its grants. The app role
--      is never a table owner; migrations keep running as the owner (whoever runs them).
--   2. the RLS helper functions. The principal and the system context are TRANSACTION-LOCAL settings
--      (`set_config(..., true)`), set by `withPrincipal` / `withSystemContext` in packages/db/src/rls.ts.
--   3. ENABLE + FORCE row-level security, with policies, on the slice-1 tables:
--      users, auth_mfa_pending, approvals, audit_log.
--
-- Secure by default: an unset or empty setting is NULL, every policy compares against it, so a
-- transaction with no principal and no system context sees ZERO rows, never all rows.
--
-- FORCE means the table owner is filtered too. A superuser (the local demo, docker-compose and CI) and a
-- role with BYPASSRLS are not; that is Postgres semantics, and ADR-0234 records how the runtime moves off
-- such a login. A LATER migration that reads or writes rows of these tables must first run
--   SELECT set_config('regulait.system_context', 'migration', true);
-- or, on a non-superuser owner, it silently touches zero rows. zz-adr0234-rls-slice1.test.ts enforces this.

-- 1. The runtime role ----------------------------------------------------------------------------------
-- Roles are cluster-wide and every test database migrates concurrently, so creation tolerates a race.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'regulait_app') THEN
    BEGIN
      CREATE ROLE regulait_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- another database's migration created it first
    END;
  END IF;
END
$$;
--> statement-breakpoint
-- the login that runs the gateway (today: the same login that migrates) must be able to assume it
DO $$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'regulait_app', 'MEMBER') THEN
    EXECUTE pg_catalog.format('GRANT regulait_app TO %I', current_user);
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO regulait_app;
--> statement-breakpoint
-- no TRUNCATE, REFERENCES or TRIGGER: the app never needs them
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO regulait_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO regulait_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO regulait_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO regulait_app;
--> statement-breakpoint
-- ADR-0060 follow-up 6, least privilege: the evidence tables are append-only for the app role. The
-- 0060/0185 triggers already refuse UPDATE, DELETE and TRUNCATE; without the privilege the statement
-- never reaches them.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, audit_anchors FROM regulait_app;
--> statement-breakpoint

-- 2. Helper functions ----------------------------------------------------------------------------------
-- The authenticated principal, or NULL. An empty string (what a reset custom setting reads back as on a
-- connection that set it once) is NULL too. A malformed value fails the cast: fail loud, never widen.
CREATE FUNCTION regulait_rls_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT nullif(current_setting('regulait.user_id', true), '')::uuid $$;
--> statement-breakpoint
-- The explicit system context, or NULL. The registry is CLOSED: a value outside it raises, so a typo in a
-- system path fails the statement instead of quietly matching no policy (or, worse, a future one).
-- Keep this list identical to RLS_SYSTEM_REASONS in packages/db/src/rls.ts (a test compares them).
CREATE FUNCTION regulait_rls_system_reason() RETURNS text
  LANGUAGE plpgsql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r text := nullif(current_setting('regulait.system_context', true), '');
BEGIN
  IF r IS NULL THEN
    RETURN NULL;
  END IF;
  IF r = ANY (ARRAY['authenticate', 'identity_provisioning', 'audit_chain', 'audit_verify',
                    'approval_maintenance', 'rls_membership', 'migration']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
-- Is the principal an ACTIVE admin? Read under the `rls_membership` context, which the function's own SET
-- clause enters and leaves around the call, so it works whatever context the caller is in.
CREATE FUNCTION regulait_rls_is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(
    (SELECT u.is_admin AND u.disabled_at IS NULL FROM public.users u WHERE u.id = public.regulait_rls_user_id()),
    false)
$$;
--> statement-breakpoint
-- The roles and teams the principal belongs to (approval routing, ADR-0046; approver pools, ADR-0186 A).
CREATE FUNCTION regulait_rls_principal_groups() RETURNS uuid[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(array_agg(g), '{}'::uuid[]) FROM (
    SELECT ra.role_id AS g FROM public.role_assignments ra WHERE ra.user_id = public.regulait_rls_user_id()
    UNION
    SELECT tm.team_id FROM public.team_members tm WHERE tm.user_id = public.regulait_rls_user_id()
  ) s
$$;
--> statement-breakpoint

-- The users who are actively delegating their approvals to the principal (ADR-0022).
CREATE FUNCTION regulait_rls_principal_delegators() RETURNS uuid[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(array_agg(DISTINCT d.from_user_id), '{}'::uuid[]) FROM public.approval_delegations d
   WHERE d.to_user_id = public.regulait_rls_user_id() AND d.starts_at <= now() AND d.ends_at > now()
$$;
--> statement-breakpoint

-- 3. Policies ------------------------------------------------------------------------------------------
-- Every helper is wrapped in a scalar sub-select so Postgres evaluates it once per statement (an initplan),
-- not once per row. That is what keeps the measured cost in ADR-0234 small.

-- users: the directory is readable by any authenticated principal (approver pickers, display names);
-- a row is writable by its own user or an admin. Pre-authentication reads (sign-in, session resolution)
-- run under `authenticate`; SCIM and the seed under `identity_provisioning`.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'identity_provisioning', 'rls_membership', 'migration'])
);
--> statement-breakpoint
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['identity_provisioning', 'migration'])
);
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    id = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'identity_provisioning', 'migration'])
  )
  WITH CHECK (
    id = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'identity_provisioning', 'migration'])
  );
--> statement-breakpoint
CREATE POLICY users_delete ON users FOR DELETE USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['identity_provisioning', 'migration'])
);
--> statement-breakpoint

-- auth_mfa_pending: a challenge belongs to one user and is read before a principal exists.
ALTER TABLE auth_mfa_pending ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_mfa_pending FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_mfa_pending_all ON auth_mfa_pending FOR ALL
  USING (
    user_id = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'migration'])
  )
  WITH CHECK (
    user_id = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'migration'])
  );
--> statement-breakpoint

-- approvals: a SUPERSET of every gateway visibility branch (requester, approver, named approver, decider,
-- approver-role member, active delegate, routing assignee by user/role/team, recorded decider). The
-- gateway's own scope check stays the fine-grained rule; this is the wall behind it. Review-role rows
-- (ADR-0168) are visible to any principal because review-role membership lives in JSON configuration,
-- not a table: a known widening, recorded in ADR-0234 and narrowed in a later batch.
-- SHAPE (measured, ADR-0234): no correlated subquery. Delegators, groups and the principal's assigned or
-- decided approval ids are computed ONCE per statement (initplans and one hashed subplan), so each row costs
-- a few comparisons and a hash probe. The first, correlated draft cost 10-17x on a 100k-row scan.
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY approvals_select ON approvals FOR SELECT USING (
  (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
  OR (SELECT regulait_rls_is_admin())
  OR user_id = (SELECT regulait_rls_user_id())
  OR approver_user_id = (SELECT regulait_rls_user_id())
  OR named_approver_user_id = (SELECT regulait_rls_user_id())
  OR decided_by = (SELECT regulait_rls_user_id())
  OR (review_role_id IS NOT NULL AND (SELECT regulait_rls_user_id()) IS NOT NULL)
  OR approver_role_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
  OR approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
  OR named_approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
  OR id IN (
    SELECT aa.approval_id FROM approval_assignments aa
     WHERE aa.assignee_id = (SELECT regulait_rls_user_id())
        OR aa.escalation_assignee_id = (SELECT regulait_rls_user_id())
        OR aa.assignee_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
        OR aa.escalation_assignee_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
    UNION ALL
    SELECT ad.approval_id FROM approval_decisions ad WHERE ad.decider_user_id = (SELECT regulait_rls_user_id()))
);
--> statement-breakpoint
-- a principal queues approvals for its OWN calls; anything else is the system or an admin
CREATE POLICY approvals_insert ON approvals FOR INSERT WITH CHECK (
  user_id = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
);
--> statement-breakpoint
-- deciding, claiming and routing: only rows the principal can see. The decide path re-checks eligibility.
-- WITH CHECK is deliberately the same visibility minus nothing: routing may re-point a row away from the
-- router, so the new row only has to be one the system, an admin or a participant could act on.
CREATE POLICY approvals_update ON approvals FOR UPDATE
  USING (
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
    OR (SELECT regulait_rls_is_admin())
    OR user_id = (SELECT regulait_rls_user_id())
    OR approver_user_id = (SELECT regulait_rls_user_id())
    OR named_approver_user_id = (SELECT regulait_rls_user_id())
    OR decided_by = (SELECT regulait_rls_user_id())
    OR (review_role_id IS NOT NULL AND (SELECT regulait_rls_user_id()) IS NOT NULL)
    OR approver_role_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
    OR approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
    OR named_approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
    OR id IN (
      SELECT aa.approval_id FROM approval_assignments aa
       WHERE aa.assignee_id = (SELECT regulait_rls_user_id())
          OR aa.escalation_assignee_id = (SELECT regulait_rls_user_id())
          OR aa.assignee_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
          OR aa.escalation_assignee_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
      UNION ALL
      SELECT ad.approval_id FROM approval_decisions ad WHERE ad.decider_user_id = (SELECT regulait_rls_user_id()))
  )
  WITH CHECK (
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
    OR (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_user_id()) IS NOT NULL
  );
--> statement-breakpoint
CREATE POLICY approvals_delete ON approvals FOR DELETE USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
);
--> statement-breakpoint

-- audit_log, the read path: an admin reads everything, a principal reads the rows about itself. The chain
-- writer reads the tip under `audit_chain` (audit-chain.ts enters and leaves it around the read, under the
-- append lock), and verification/export jobs run under `audit_verify`. Any authenticated principal or system
-- path may APPEND; nobody may UPDATE or DELETE (no policy, no privilege, and the 0060 triggers).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (
  user_id = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['audit_chain', 'audit_verify', 'migration'])
);
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_system_reason()) IS NOT NULL
);
