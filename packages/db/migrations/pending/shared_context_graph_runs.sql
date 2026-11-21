-- ADR-0365 slice 2 (lane E46): scheduled sync, and edges from PM work items to RegulAIt orchestration runs through
-- pm_links. Hand-authored (never drizzle-kit generate), additive and idempotent. The file name sorts right after
-- `shared_context_graph.sql` (byte order: '.' < '_'), which it extends. It adds no system reason, so it does not
-- redefine regulait_rls_system_reason().
--
-- What changes:
--   context_graph_nodes       a third kind, `orchestration_run` (one per source and run), with a foreign key to the
--                             run (cascade: a deleted run leaves no node).
--   context_graph_edges       a second kind, `tracks` (a work item tracks a run, from a live pm_links row).
--   context_graph_node_user_scopes  a second access scope, by user: when a node has rows here, the reader must be one
--                             of them (an admin aside), on top of every project scope. A run node gets one row, the
--                             run's initiator, because a run is visible to its initiator and admins only
--                             (orchestration.ts loadRunFor); a project scope alone would widen it to every member.
--   context_graph_sources     `links_synced_at`: the incremental link window (re-read with the same 10-minute overlap).
--   regulait_context_graph_node_readable  now also requires the user scope. It still reads only the scope tables (never
--                             the nodes table), so a node policy that calls it cannot recurse.
--   system_task               the scheduled sync (hourly incremental, daily full) runs under `system_task`, so the four
--                             graph tables and the user-scope table admit it, and pm_imported_work_items admits it for
--                             SELECT only. pm_links already admits `system_task` (rls_pm_tables).

ALTER TABLE "context_graph_nodes" ADD COLUMN IF NOT EXISTS "orchestration_run_id" uuid
  REFERENCES "orchestration_runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" DROP CONSTRAINT IF EXISTS "context_graph_nodes_kind_check";
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" ADD CONSTRAINT "context_graph_nodes_kind_check" CHECK (CASE "kind"
  WHEN 'pm_project' THEN "pm_imported_work_item_id" IS NULL AND "orchestration_run_id" IS NULL
  WHEN 'pm_work_item' THEN "pm_imported_work_item_id" IS NOT NULL AND "orchestration_run_id" IS NULL
  WHEN 'orchestration_run' THEN "orchestration_run_id" IS NOT NULL AND "pm_imported_work_item_id" IS NULL
  ELSE false END);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_nodes_source_run_uq" ON "context_graph_nodes" ("source_id", "orchestration_run_id") WHERE "orchestration_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_nodes_run_idx" ON "context_graph_nodes" ("orchestration_run_id") WHERE "orchestration_run_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_graph_edges" DROP CONSTRAINT IF EXISTS "context_graph_edges_kind_check";
--> statement-breakpoint
ALTER TABLE "context_graph_edges" ADD CONSTRAINT "context_graph_edges_kind_check" CHECK ("kind" IN ('contains', 'tracks'));
--> statement-breakpoint
ALTER TABLE "context_graph_sources" ADD COLUMN IF NOT EXISTS "links_synced_at" timestamp with time zone;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "context_graph_node_user_scopes" (
  "node_id" uuid NOT NULL REFERENCES "context_graph_nodes"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "context_graph_node_user_scopes_pk" PRIMARY KEY ("node_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_node_user_scopes_user_idx" ON "context_graph_node_user_scopes" ("user_id", "node_id");
--> statement-breakpoint

-- The readable predicate, extended: every project scope (at least one), and, when the node has user scopes, the reader
-- among them. Reads only the scope tables and users, under `rls_membership`; search_path pinned (zz-dbguard-0185).
CREATE OR REPLACE FUNCTION regulait_context_graph_node_readable(p_node uuid, p_user uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public, pg_temp
  SET regulait.system_context = 'rls_membership'
AS $$
  SELECT coalesce(
    (SELECT u.disabled_at IS NULL FROM public.users u WHERE u.id = p_user), false)
    AND EXISTS (SELECT 1 FROM public.context_graph_node_scopes s WHERE s.node_id = p_node)
    AND NOT EXISTS (
      SELECT 1 FROM public.context_graph_node_scopes s
      WHERE s.node_id = p_node
        AND NOT EXISTS (
          SELECT 1 FROM public.project_members m
          WHERE m.project_id = s.project_id AND m.user_id = p_user))
    AND (
      NOT EXISTS (SELECT 1 FROM public.context_graph_node_user_scopes us WHERE us.node_id = p_node)
      OR EXISTS (SELECT 1 FROM public.context_graph_node_user_scopes us WHERE us.node_id = p_node AND us.user_id = p_user))
$$;
--> statement-breakpoint

ALTER TABLE "context_graph_node_user_scopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_node_user_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_node_user_scopes_admin" ON "context_graph_node_user_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_user_scopes_admin" ON "context_graph_node_user_scopes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_node_user_scopes_membership" ON "context_graph_node_user_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_user_scopes_membership" ON "context_graph_node_user_scopes" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'rls_membership');
--> statement-breakpoint

-- the scheduled sync runs under system_task: the graph tables admit it for every command
DROP POLICY IF EXISTS "context_graph_sources_admin" ON "context_graph_sources";
--> statement-breakpoint
CREATE POLICY "context_graph_sources_admin" ON "context_graph_sources" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_nodes_admin" ON "context_graph_nodes";
--> statement-breakpoint
CREATE POLICY "context_graph_nodes_admin" ON "context_graph_nodes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_edges_admin" ON "context_graph_edges";
--> statement-breakpoint
CREATE POLICY "context_graph_edges_admin" ON "context_graph_edges" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_node_scopes_admin" ON "context_graph_node_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_scopes_admin" ON "context_graph_node_scopes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
-- the sync reads the imported items it projects (read only; the importer's writes stay admin-only)
DROP POLICY IF EXISTS "pm_imported_work_items_context_graph_sync" ON "pm_imported_work_items";
--> statement-breakpoint
CREATE POLICY "pm_imported_work_items_context_graph_sync" ON "pm_imported_work_items" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'system_task');
