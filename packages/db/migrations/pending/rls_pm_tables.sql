-- ADR-0234 PM batch (builder lane L6, #828 review; owner decision 2026-11-15: row-level security on ALL PM tables).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. The file name sorts after
-- `pm_work_item_import.sql` (which creates two of the tables) and after `rls_batch7a_system_scopes.sql` and
-- `rls_batch7b_runtime_cutover.sql` (whose reason registry this one extends: it is their list plus `pm_sync`), so the
-- numbering at merge keeps that order.
--
-- The PM tables carry no org_id (ADR-0041) and no owner column: a connection, its links, its inbound log and its
-- import linkage are deployment configuration an admin manages. So every policy follows the ADR-0234 pattern for
-- admin-managed rows: an active admin principal (or the bootstrap token) through regulait_rls_is_admin(), plus a
-- closed list of named system reasons for the paths that run without one.
--
-- One reason is added to the closed registry:
--   pm_sync   the PM mirror and link work a request does on behalf of a principal who need not be an admin: a run
--             node or sign-off decision mirrored to the linked work item, a run or workflow instance linked to one, a
--             decision record, the links read and the governance-alert ticket lookups. Entered as a principal step
--             (`runAsPrincipalStepIfScoped`), so the principal still writes its own audit rows. Reaches pm_connections
--             (read), pm_links (all) and pm_sync_events (read, append). Never the webhook delivery records or the
--             import linkage.
--
-- Existing reasons gain PM tables:
--   approval_maintenance  the PM webhook route's scope since batch 7a: pm_connections (read), pm_links (all),
--                         pm_sync_events (read, append), pm_webhook_deliveries (all: record, dedupe, release on failure).
--                         The chat approval callback shares the reason and so reaches the same rows; it reads none.
--   system_task           scheduler jobs and boot timers: pm_connections (read), pm_links (all), pm_sync_events (read,
--                         append), pm_webhook_deliveries (read, delete: the 30-day retention prune).
--   migration             every PM table, for a later data step.
--
-- pm_project_initiatives and pm_imported_work_items (ADR-0289) admit an admin and `migration` only: the importer's
-- routes are admin-only and no other path reads them.
--
-- Foreign-key cascades (deleting a connection removes its links, events, deliveries and import linkage) are not
-- subject to row-level security, so an admin deleting a connection still clears every dependent row.

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
                    'system_task', 'public_ingest', 'bootstrap_admin', 'audit_retention',
                    'credential_request', 'pm_sync']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

-- pm_connections: read by the sync, webhook and job paths; written by an admin only.
ALTER TABLE pm_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_connections_select ON pm_connections;
--> statement-breakpoint
CREATE POLICY pm_connections_select ON pm_connections FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['pm_sync', 'approval_maintenance', 'system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_connections_write ON pm_connections;
--> statement-breakpoint
CREATE POLICY pm_connections_write ON pm_connections FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

-- pm_links: created, synced and orphaned by the sync, webhook and job paths.
ALTER TABLE pm_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_links_all ON pm_links;
--> statement-breakpoint
CREATE POLICY pm_links_all ON pm_links FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['pm_sync', 'approval_maintenance', 'system_task', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['pm_sync', 'approval_maintenance', 'system_task', 'migration'])
  );
--> statement-breakpoint

-- pm_sync_events: the append-only inbound log. Read and appended by the same paths; changed by an admin or a
-- migration only.
ALTER TABLE pm_sync_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_sync_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_sync_events_select ON pm_sync_events;
--> statement-breakpoint
CREATE POLICY pm_sync_events_select ON pm_sync_events FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['pm_sync', 'approval_maintenance', 'system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_sync_events_insert ON pm_sync_events;
--> statement-breakpoint
CREATE POLICY pm_sync_events_insert ON pm_sync_events FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['pm_sync', 'approval_maintenance', 'system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_sync_events_change ON pm_sync_events;
--> statement-breakpoint
CREATE POLICY pm_sync_events_change ON pm_sync_events FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

-- pm_webhook_deliveries: the replay records. Written by the webhook route (approval_maintenance), pruned by the boot
-- timer (system_task). The sync path never reads them.
ALTER TABLE pm_webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_webhook_deliveries_all ON pm_webhook_deliveries;
--> statement-breakpoint
CREATE POLICY pm_webhook_deliveries_all ON pm_webhook_deliveries FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
  );
--> statement-breakpoint
DROP POLICY IF EXISTS pm_webhook_deliveries_prune_select ON pm_webhook_deliveries;
--> statement-breakpoint
CREATE POLICY pm_webhook_deliveries_prune_select ON pm_webhook_deliveries FOR SELECT USING (
  (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'system_task'
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_webhook_deliveries_prune_delete ON pm_webhook_deliveries;
--> statement-breakpoint
CREATE POLICY pm_webhook_deliveries_prune_delete ON pm_webhook_deliveries FOR DELETE USING (
  (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'system_task'
);
--> statement-breakpoint

-- ADR-0289's import tables: admin and migration only.
ALTER TABLE pm_project_initiatives ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_project_initiatives FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_project_initiatives_admin ON pm_project_initiatives;
--> statement-breakpoint
CREATE POLICY pm_project_initiatives_admin ON pm_project_initiatives FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint
ALTER TABLE pm_imported_work_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_imported_work_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_imported_work_items_admin ON pm_imported_work_items;
--> statement-breakpoint
CREATE POLICY pm_imported_work_items_admin ON pm_imported_work_items FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
