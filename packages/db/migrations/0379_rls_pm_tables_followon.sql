-- ADR-0234 PM follow-on: per-row object visibility for the PM links, row-level security on decisions, and the
-- append-only and column-level privileges the PM batch left out.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. The file name sorts right
-- after `rls_pm_tables.sql` (byte order: '.' < '_'), whose policies it layers on, so the numbering at merge keeps that
-- order. It adds no system reason, so it does not redefine regulait_rls_system_reason().
--
-- What changes, on top of rls_pm_tables:
--   pm_links       the `pm_sync` reason no longer opens every link. Under `pm_sync` a non-admin principal reaches only
--                  the links of objects regulait_rls_pm_object_visible() admits for THAT principal: reads for an object
--                  it may see, inserts and updates for an object it may write, and no delete. An admin, and
--                  `approval_maintenance` (the PM webhook, and the approval decide path that mirrors a decision),
--                  `system_task` and `migration` keep what rls_pm_tables gave them. The app role updates only the
--                  sync-state columns: a link's identity (connection, object, node, external id and URL) is immutable.
--   pm_sync_events the app role can no longer UPDATE, DELETE or TRUNCATE the inbound log. Deleting a connection still
--                  removes its events: a foreign-key cascade runs as the table owner, outside row-level security.
--   decisions      ENABLE and FORCE row-level security. Read by an admin, `migration`, `rls_membership` (the helper
--                  below), the decision's maker, and whoever may see the decision's object. Recorded only in the
--                  principal's own name, on an object it may write (or as an admin). Never updated or deleted by the
--                  app role.
--
-- regulait_rls_pm_object_visible(type, id, writing) mirrors the gateway's own object checks (pm.ts, orchestration.ts):
--   run, run_node       the run's initiator; for a read only, the named approver of a PENDING approval on the run;
--   workflow_instance   the instance's initiator; for a read only, the named approver of a PENDING approval on it;
--   decision            the decision's maker, or (one level, never recursive) whoever the rule above admits for the
--                       decision's run or instance;
--   governance_alert    the alert's owner, read only (an admin, the scheduler or the decide path files the ticket).
-- It runs under `rls_membership`, like the 0272 helpers; the principal setting stays set, so the approvals read sees
-- only the approvals the principal is the named approver of.
--
-- A decider who is not the run's initiator still mirrors a decided approval: the decide path (app.ts
-- decideOneApproval) runs its whole step, the PM mirror included, under `approval_maintenance`, which this file leaves
-- as it was. Nothing here reads or writes rows, so no migration context is entered.

CREATE OR REPLACE FUNCTION regulait_rls_pm_object_visible(p_otype text, p_oid uuid, p_writing boolean) RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
DECLARE
  uid uuid := public.regulait_rls_user_id();
  t text := p_otype;
  o uuid := p_oid;
  maker uuid;
BEGIN
  IF uid IS NULL OR p_oid IS NULL OR p_otype IS NULL THEN
    RETURN false;
  END IF;
  IF t = 'decision' THEN
    SELECT d.decision_maker_user_id, d.object_type, d.object_id INTO maker, t, o
      FROM public.decisions d WHERE d.id = p_oid;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF maker = uid THEN
      RETURN true;
    END IF;
  END IF;
  IF t IN ('run', 'run_node') THEN
    RETURN EXISTS (SELECT 1 FROM public.orchestration_runs r WHERE r.id = o AND r.initiating_user_id = uid)
      OR (NOT p_writing AND EXISTS (
            SELECT 1 FROM public.approvals a WHERE a.run_id = o AND a.approver_user_id = uid AND a.status = 'pending'));
  END IF;
  IF t = 'workflow_instance' THEN
    RETURN EXISTS (SELECT 1 FROM public.workflow_instances w WHERE w.id = o AND w.initiator_user_id = uid)
      OR (NOT p_writing AND EXISTS (
            SELECT 1 FROM public.approvals a WHERE a.instance_id = o AND a.approver_user_id = uid AND a.status = 'pending'));
  END IF;
  IF t = 'governance_alert' THEN
    RETURN NOT p_writing AND EXISTS (SELECT 1 FROM public.governance_alerts g WHERE g.id = o AND g.owner_user_id = uid);
  END IF;
  RETURN false;
END
$$;
--> statement-breakpoint

-- pm_links: rls_pm_tables' single policy loses its `pm_sync` branch; `pm_sync` gets per-row policies of its own.
DROP POLICY IF EXISTS pm_links_all ON pm_links;
--> statement-breakpoint
CREATE POLICY pm_links_all ON pm_links FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'system_task', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'system_task', 'migration'])
  );
--> statement-breakpoint
DROP POLICY IF EXISTS pm_links_pm_sync_select ON pm_links;
--> statement-breakpoint
CREATE POLICY pm_links_pm_sync_select ON pm_links FOR SELECT USING (
  (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'pm_sync'
  AND regulait_rls_pm_object_visible(object_type, object_id, false)
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_links_pm_sync_insert ON pm_links;
--> statement-breakpoint
CREATE POLICY pm_links_pm_sync_insert ON pm_links FOR INSERT WITH CHECK (
  (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'pm_sync'
  AND regulait_rls_pm_object_visible(object_type, object_id, true)
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_links_pm_sync_update ON pm_links;
--> statement-breakpoint
CREATE POLICY pm_links_pm_sync_update ON pm_links FOR UPDATE
  USING (
    (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'pm_sync'
    AND regulait_rls_pm_object_visible(object_type, object_id, true)
  )
  WITH CHECK (
    (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'pm_sync'
    AND regulait_rls_pm_object_visible(object_type, object_id, true)
  );
--> statement-breakpoint
-- A link's identity is immutable for the app role; what the sync, the mirror and the webhook record is its sync state
-- (pm.ts updates exactly these columns). The grant is by column, so a column added later is not updatable until its
-- migration grants it (the 0272 approvals rule).
REVOKE UPDATE ON pm_links FROM regulait_app;
--> statement-breakpoint
GRANT UPDATE (last_synced_at, orphaned_at, inbound_state, inbound_at, adopted_state) ON pm_links TO regulait_app;
--> statement-breakpoint

-- pm_sync_events: the append-only inbound log. The 0272 default privileges granted UPDATE and DELETE.
REVOKE UPDATE, DELETE, TRUNCATE ON pm_sync_events FROM regulait_app;
--> statement-breakpoint

-- decisions: a governance record (FK-free by design, like audit_log).
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE decisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS decisions_select ON decisions;
--> statement-breakpoint
CREATE POLICY decisions_select ON decisions FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['rls_membership', 'migration'])
  OR decision_maker_user_id = (SELECT regulait_rls_user_id())
  OR regulait_rls_pm_object_visible(object_type, object_id, false)
);
--> statement-breakpoint
DROP POLICY IF EXISTS decisions_insert ON decisions;
--> statement-breakpoint
CREATE POLICY decisions_insert ON decisions FOR INSERT WITH CHECK (
  decision_maker_user_id = (SELECT regulait_rls_user_id())
  AND ((SELECT regulait_rls_is_admin()) OR regulait_rls_pm_object_visible(object_type, object_id, true))
);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON decisions FROM regulait_app;
