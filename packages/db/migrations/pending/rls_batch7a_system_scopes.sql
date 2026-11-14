-- ADR-0234 batch 7a (PENDING S7): named scopes for every path that ran with no scope.
--
-- Until now the paths that resolve no user (auth-exempt routes, bootstrap-token requests, scheduler jobs, boot tasks,
-- timers and background work) ran with no RLS scope. On today's superuser runtime login that means "no RLS at all";
-- on the non-superuser runtime login batch 7b introduces it would mean "zero rows". Batch 7a gives each of them a
-- named, closed system reason, so they run as `regulait_app` under the policies from now on, whatever the login.
--
-- Two reasons are added to the closed registry:
--   system_task      scheduler jobs, boot tasks, the audit anchor and backup-verify timers, background work and the
--                    public ingest routes (portals, agents, OAuth endpoints). users: read (actor lookups);
--                    audit_log: append (any registered reason may append; slice 1). Nothing in approvals: a job that
--                    acts on approvals runs under approval_maintenance instead.
--   bootstrap_admin  a request authenticated by the bootstrap token, which the gateway already treats as an admin
--                    with no user row (ADR-0234 batch 2 recorded it as unscoped). It is admitted exactly where an
--                    active admin principal is, through regulait_rls_is_admin(), and to the users read.
--
-- approval_maintenance gains the users read: the chatops and PM webhook paths that decide or route an approval look
-- the deciding user up in the same request.

CREATE OR REPLACE FUNCTION regulait_rls_system_reason() RETURNS text
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
                    'approval_maintenance', 'rls_membership', 'migration', 'audit_subject',
                    'system_task', 'bootstrap_admin']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- The principal-is-admin read moves to its own helper (it keeps the rls_membership SET clause, so reading users
-- does not recurse into the users policies). regulait_rls_is_admin() itself has no SET clause any more, so it still
-- sees the caller's reason, and answers true for a bootstrap-token request. Every policy that already calls
-- regulait_rls_is_admin() therefore admits bootstrap_admin without being re-created.
CREATE FUNCTION regulait_rls_principal_is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(
    (SELECT u.is_admin AND u.disabled_at IS NULL FROM public.users u WHERE u.id = public.regulait_rls_user_id()),
    false)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION regulait_rls_principal_is_admin() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION regulait_rls_principal_is_admin() TO regulait_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION regulait_rls_is_admin() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.regulait_rls_system_reason() IS NOT DISTINCT FROM 'bootstrap_admin'
      OR public.regulait_rls_principal_is_admin()
$$;
--> statement-breakpoint

DROP POLICY users_select ON users;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'identity_provisioning', 'rls_membership',
                                                        'migration', 'system_task', 'bootstrap_admin',
                                                        'approval_maintenance'])
);
