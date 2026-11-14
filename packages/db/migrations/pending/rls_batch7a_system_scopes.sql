-- ADR-0234 batch 7a (PENDING S7): named scopes for every path that ran with no scope.
--
-- Until now the paths that resolve no user (auth-exempt routes, bootstrap-token requests, scheduler jobs, boot tasks,
-- timers and background work) ran with no RLS scope. On today's superuser runtime login that means "no RLS at all";
-- on the non-superuser runtime login batch 7b introduces it would mean "zero rows". Batch 7a gives each of them a
-- named, closed system reason, so they run as `regulait_app` under the policies from now on, whatever the login.
--
-- Three reasons are added to the closed registry:
--   system_task      server-side work with no principal: scheduler jobs, boot tasks, the audit anchor and backup-verify
--                    timers, background work, and requests from non-user credentials (engine runners, workload
--                    identities, endpoint agents). users: read; approvals: all (a job's model dispatch may escalate a
--                    budget into an approval; the SLA, spend, recertification and condition sweeps route and reopen
--                    them); audit_log: read and append. It never writes users or touches auth_mfa_pending, and the
--                    ledger stays append-only (the app role has no UPDATE or DELETE on audit_log).
--   public_ingest    the unauthenticated portal, ingest and webhook routes (trust pages, supplier portal, feedback
--                    links, endpoint-agent and third-party ingest, OAuth endpoints, chat events). users: read;
--                    audit_log: append. Nothing else: these take attacker-shaped input, so they get the narrowest
--                    reason.
--   bootstrap_admin  a request authenticated by the bootstrap token, which the gateway already treats as an admin
--                    with no user row (ADR-0234 batch 2 recorded it as unscoped). It is admitted exactly where an
--                    active admin principal is, through regulait_rls_is_admin(), and to the users read.
--
-- approval_maintenance gains the users read: the chatops and PM webhook paths that decide or route an approval look
-- the deciding user up in the same request. audit_verify gains it too: a ledger reader names the users whose rows it
-- reads (the policy simulator's replay), which a bootstrap-token request, having no principal, could not otherwise do.

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
                    'system_task', 'public_ingest', 'bootstrap_admin']) THEN
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
-- No REVOKE: every role that evaluates a policy calls this (the app role, the owner, a migrator), and it answers only
-- whether the CALLER is an active admin, as the 0272 helper it replaces did.
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
                                                        'migration', 'system_task', 'public_ingest',
                                                        'bootstrap_admin', 'approval_maintenance', 'audit_verify'])
);
--> statement-breakpoint

-- system_task acts on every approval (a job's model dispatch may escalate a budget into an approval; the SLA, spend,
-- recertification and condition sweeps route and reopen them) and reads the audit ledger (rate-limit counts,
-- idempotency markers, required-test evidence, anchors). The policies below are the 0272 / 0313 ones with
-- 'system_task' added to their system branch, and nothing else changed.
DROP POLICY approvals_select ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_select ON approvals FOR SELECT USING (
  (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration', 'system_task'])
  OR (SELECT regulait_rls_is_admin())
  OR user_id = (SELECT regulait_rls_user_id())
  OR approver_user_id = (SELECT regulait_rls_user_id())
  OR named_approver_user_id = (SELECT regulait_rls_user_id())
  OR decided_by = (SELECT regulait_rls_user_id())
  OR (review_role_id IS NOT NULL AND (SELECT regulait_rls_user_id()) IS NOT NULL)
  OR approver_role_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
  OR approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
  OR approver_role_id = ANY ((SELECT regulait_rls_delegator_groups())::uuid[])
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
DROP POLICY approvals_insert ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_insert ON approvals FOR INSERT WITH CHECK (
  user_id = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration', 'system_task'])
);
--> statement-breakpoint
DROP POLICY approvals_update ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_update ON approvals FOR UPDATE
  -- #682 review: no review-role branch here (seeing a review-role row is not a right to write it); a principal
  -- writes only rows it takes part in, and the NEW row must still be one it takes part in. The routing identity
  -- columns are not updatable by the app role at all (0272 column privileges).
  USING (
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration', 'system_task'])
    OR (SELECT regulait_rls_is_admin())
    OR user_id = (SELECT regulait_rls_user_id())
    OR approver_user_id = (SELECT regulait_rls_user_id())
    OR named_approver_user_id = (SELECT regulait_rls_user_id())
    OR decided_by = (SELECT regulait_rls_user_id())
    OR approver_role_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
    OR approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
    OR approver_role_id = ANY ((SELECT regulait_rls_delegator_groups())::uuid[])
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
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration', 'system_task'])
    OR (SELECT regulait_rls_is_admin())
    OR (
        user_id = (SELECT regulait_rls_user_id())
      OR approver_user_id = (SELECT regulait_rls_user_id())
      OR named_approver_user_id = (SELECT regulait_rls_user_id())
      OR decided_by = (SELECT regulait_rls_user_id())
      OR approver_role_id = ANY ((SELECT regulait_rls_principal_groups())::uuid[])
      OR approver_user_id = ANY ((SELECT regulait_rls_principal_delegators())::uuid[])
      OR approver_role_id = ANY ((SELECT regulait_rls_delegator_groups())::uuid[])
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
  );
--> statement-breakpoint
DROP POLICY approvals_delete ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_delete ON approvals FOR DELETE USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration', 'system_task'])
);
--> statement-breakpoint
DROP POLICY audit_log_select ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (
  user_id = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['audit_chain', 'audit_verify', 'audit_subject', 'migration', 'system_task'])
);
--> statement-breakpoint

-- The anchor timer (system_task) and the admin's timestamp retry (a principal or bootstrap_admin) now run as the app
-- role, which 0272 gave no UPDATE on audit_anchors. An anchor row's evidence (which head it anchors, where, when) stays
-- immutable for the app role; its delivery and timestamp state is what those paths record. The grant is by column,
-- so a column added later is not updatable until its migration grants it (the 0272 approvals rule).
DO $$
DECLARE cols text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.audit_anchors'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('id', 'seq', 'row_hash', 'head_at', 'algorithm', 'destination', 'deploy_mode', 'created_at');
  EXECUTE pg_catalog.format('GRANT UPDATE (%s) ON public.audit_anchors TO regulait_app', cols);
END
$$;
