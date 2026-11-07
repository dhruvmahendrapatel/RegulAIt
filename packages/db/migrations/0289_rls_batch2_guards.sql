-- ADR-0234 batch 2 (PENDING S7): the column guard on users updates, and the audit_subject reason.
--
-- The #682 review set a hard gate: `authenticate` (sign-in and session resolution) may not write `users` until a
-- guard stops it changing the columns that grant or describe identity. RLS cannot compare the old row with the new
-- one directly, but a STABLE helper reads the row as it was before the statement (the statement snapshot does not
-- see its own update), so the guard compares the guarded columns of the new row with the stored ones.
--
-- Guarded columns: is_admin, disabled_at, email, username, scim_external_id, cost_center. They change only through
-- an active admin, `identity_provisioning` (SCIM, the seed) or a migration. The same guard (minus username, which a
-- user may change itself through POST /auth/username) now applies to a user editing its own row. It replaces the
-- slice-1 "not admin, not disabled" check and closes the ADR-0234 threat-model note that self-edits of email or cost
-- centre were guarded only by the gateway.
--
-- `authenticate` and the principal may still change everything else on the row (failed-login counters, lockout,
-- password hash and rehash, MFA state, last-used step).
-- The stored guarded columns of one user, as a digest. A SQL function with a SET clause is planned on its own (like
-- the 0272 membership helpers), so reading `users` here does not recurse into the users policies; it reads under
-- `rls_membership` and returns only a digest, never the columns, so it discloses nothing the directory read does not.
-- STABLE: it sees the snapshot of the calling statement, which is the row as it was before the UPDATE.
-- `with_username`: `authenticate` may never change a username; a user may change its own (POST /auth/username).
CREATE FUNCTION regulait_rls_users_guarded_digest(target uuid, with_username boolean) RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT pg_catalog.md5(pg_catalog.jsonb_build_array(
           u.is_admin, u.disabled_at, u.email, CASE WHEN with_username THEN u.username END, u.scim_external_id, u.cost_center)::text)
    FROM public.users u
   WHERE u.id = target
$$;
--> statement-breakpoint
DROP POLICY users_update ON users;
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    id = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['authenticate', 'identity_provisioning', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['identity_provisioning', 'migration'])
    OR (
      (SELECT regulait_rls_system_reason()) = 'authenticate'
      AND pg_catalog.md5(pg_catalog.jsonb_build_array(is_admin, disabled_at, email, username, scim_external_id, cost_center)::text)
          = regulait_rls_users_guarded_digest(id, true)
    )
    OR (
      id = (SELECT regulait_rls_user_id())
      AND pg_catalog.md5(pg_catalog.jsonb_build_array(is_admin, disabled_at, email, NULL::text, scim_external_id, cost_center)::text)
          = regulait_rls_users_guarded_digest(id, false)
    )
  );
--> statement-breakpoint

-- `audit_subject`: the audit chain writer's reason for appending a row ABOUT someone other than the principal.
--
-- audit_log.user_id is the human the work is FOR (the sponsor or subject, ADR-0188), not necessarily the actor: an
-- approver's decision row, a runner's result row and an admin action on a target user all name someone else. Under
-- the slice-1 insert policy such a row needs a registered system reason. The chain writer (audit-chain.ts, the one
-- funnel every `insert(auditLog)` goes through) enters `audit_subject` for exactly its INSERT, and only when a row
-- names a user other than the principal; it is counted and reported to the system-context sink. A raw INSERT that
-- does not go through the writer still has to name the principal: the slice-1 forgery test still holds for it.
--
-- It is added to the closed registry here, and to the audit_log read policy so the writer's own RETURNING of the row
-- it just inserted is visible (the setting is LOCAL and restored right after the INSERT).
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
                    'approval_maintenance', 'rls_membership', 'migration', 'audit_subject']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
DROP POLICY audit_log_select ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (
  user_id = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['audit_chain', 'audit_verify', 'audit_subject', 'migration'])
);
--> statement-breakpoint

-- The roles and teams of the users actively delegating to the principal (ADR-0022 x ADR-0046): an active delegate of
-- an approver-role member is eligible for that role's approvals (the gateway's eligibilityOf admits it, #700 CI), so
-- the visibility superset admits it too. Read under rls_membership, like the 0272 helpers.
CREATE FUNCTION regulait_rls_delegator_groups() RETURNS uuid[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(array_agg(DISTINCT g), '{}'::uuid[]) FROM (
    SELECT ra.role_id AS g FROM public.role_assignments ra
     WHERE ra.user_id = ANY (public.regulait_rls_principal_delegators())
    UNION
    SELECT tm.team_id FROM public.team_members tm
     WHERE tm.user_id = ANY (public.regulait_rls_principal_delegators())
  ) s
$$;
--> statement-breakpoint
DROP POLICY approvals_select ON approvals;
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

-- approvals UPDATE: the slice-1 requester self-route guard is removed. Self-approval is a product decision made per
-- flow by the gateway (remediation and compliance-profile changes refuse it; a governed tool call's approval may be
-- decided by its requester when the approval rule names them), and a database rule stricter than the product
-- refused legitimate decisions once requests ran scoped. What stays: USING is the participant predicate without the
-- review-role branch, WITH CHECK requires the new row to stay one the principal takes part in, and the column
-- privileges keep the routing identity out of the app role's reach.
DROP POLICY approvals_update ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_update ON approvals FOR UPDATE
  -- #682 review: no review-role branch here (seeing a review-role row is not a right to write it); a principal
  -- writes only rows it takes part in, and the NEW row must still be one it takes part in. The routing identity
  -- columns are not updatable by the app role at all (0272 column privileges).
  USING (
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
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
    (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
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
