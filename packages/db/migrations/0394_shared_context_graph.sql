-- ADR-0365 (lane E46, slice 1): the live synced context graph (pillar 4, PENDING P2). Hand-authored (never
-- drizzle-kit generate), additive and idempotent. The file name sorts after `pm_work_item_import.sql` (which creates
-- pm_imported_work_items) and the `rls_*` files, so the numbering at merge keeps that order.
--
-- Tables: context_graph_sources, context_graph_nodes, context_graph_edges, context_graph_node_scopes.
-- Third normal form: a node stores no copy of its source's facts (label, URL, type and missing state are joined from
-- pm_connections and pm_imported_work_items at read); a node's access scope is a join table, never an array.
--
-- Secure by default (ADR-0180, ADR-0234): row-level security ENABLED and FORCED on every new table.
--  - context_graph_sources: an active admin (or the bootstrap token) and `migration`; READ also under
--    `context_graph_read`, as are pm_connections and pm_imported_work_items: read only, and only the rows a node the
--    principal may read refers to.
--  - context_graph_nodes, context_graph_edges: READ by an admin, `migration`, or a principal for whom
--    regulait_context_graph_node_readable(node, principal) holds (for an edge: for both ends). WRITE by an admin or `migration`.
--  - context_graph_node_scopes: an admin, `migration`, `rls_membership` (the readable function's own context), and
--    under `context_graph_read` the rows of the principal's own projects only.
-- Readable = the node has at least one scope row, and the principal is an active member of the project of EVERY scope
-- row (conjunctive: a further scope can only narrow). Deleting a source, connection, imported item or project cascades
-- (PostgreSQL referential actions bypass row-level security).

-- One reason is added to the closed registry (keep it identical to RLS_SYSTEM_REASONS in packages/db/src/rls.ts):
--   context_graph_read  the three node read routes, entered as a principal step, so the joined facts of a node the
--                       principal may read can be selected: context_graph_sources, pm_connections and
--                       pm_imported_work_items (SELECT only). Nodes and edges stay under the principal's own readable
--                       predicate; the reason does not widen them.

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
                    'credential_request', 'pm_sync', 'context_graph_read']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "context_graph_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pm_connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "bound_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "bound_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cursor_first_seen_at" timestamp with time zone,
  "cursor_item_id" uuid,
  "last_synced_at" timestamp with time zone,
  CONSTRAINT "context_graph_sources_cursor_check" CHECK (("cursor_first_seen_at" IS NULL) = ("cursor_item_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_sources_connection_uq" ON "context_graph_sources" ("pm_connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_sources_project_idx" ON "context_graph_sources" ("project_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "context_graph_sources"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "pm_imported_work_item_id" uuid REFERENCES "pm_imported_work_items"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_graph_nodes_kind_check" CHECK (CASE "kind"
    WHEN 'pm_project' THEN "pm_imported_work_item_id" IS NULL
    WHEN 'pm_work_item' THEN "pm_imported_work_item_id" IS NOT NULL
    ELSE false END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_nodes_work_item_uq" ON "context_graph_nodes" ("pm_imported_work_item_id") WHERE "pm_imported_work_item_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_nodes_project_uq" ON "context_graph_nodes" ("source_id") WHERE "kind" = 'pm_project';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_nodes_source_kind_idx" ON "context_graph_nodes" ("source_id", "kind", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_node_id" uuid NOT NULL REFERENCES "context_graph_nodes"("id") ON DELETE CASCADE,
  "to_node_id" uuid NOT NULL REFERENCES "context_graph_nodes"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_graph_edges_kind_check" CHECK ("kind" IN ('contains')),
  CONSTRAINT "context_graph_edges_no_loop_check" CHECK ("from_node_id" <> "to_node_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_edges_triple_uq" ON "context_graph_edges" ("from_node_id", "to_node_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_edges_to_idx" ON "context_graph_edges" ("to_node_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_node_scopes" (
  "node_id" uuid NOT NULL REFERENCES "context_graph_nodes"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "context_graph_node_scopes_pk" PRIMARY KEY ("node_id", "project_id")
);
--> statement-breakpoint
-- (project_id, node_id): the node list starts from the caller's memberships (review R4 finding 1)
CREATE INDEX IF NOT EXISTS "context_graph_node_scopes_project_idx" ON "context_graph_node_scopes" ("project_id", "node_id");
--> statement-breakpoint

-- The one readable predicate (ADR-0365 §4): may user p_user read node p_node? The policies pass the principal; the
-- routes pass the authenticated caller, so the application filter and the policy are the same rule. Admins are
-- admitted by the separate admin policies (and by the routes before they call this). Runs under `rls_membership` so it can read the scope rows and the principal's user row; search_path is
-- pinned (zz-dbguard-0185).
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
$$;
--> statement-breakpoint

ALTER TABLE "context_graph_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_sources_admin" ON "context_graph_sources";
--> statement-breakpoint
CREATE POLICY "context_graph_sources_admin" ON "context_graph_sources" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

DROP POLICY IF EXISTS "context_graph_sources_read" ON "context_graph_sources";
--> statement-breakpoint
CREATE POLICY "context_graph_sources_read" ON "context_graph_sources" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND EXISTS (SELECT 1 FROM context_graph_nodes n
                WHERE n.source_id = context_graph_sources.id
                  AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id())));
--> statement-breakpoint
-- the joined facts of a readable node (read only, under the context_graph_read principal step). Each policy follows
-- the readable rule (security review S4 finding 1): a source, connection or imported item is visible only when a node
-- the principal may read refers to it, so an unbound connection or an unreadable item is never reachable even if a
-- later route selects more columns or forgets the application filter.
DROP POLICY IF EXISTS "pm_connections_context_graph_read" ON "pm_connections";
--> statement-breakpoint
CREATE POLICY "pm_connections_context_graph_read" ON "pm_connections" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND EXISTS (SELECT 1 FROM context_graph_sources s JOIN context_graph_nodes n ON n.source_id = s.id
                WHERE s.pm_connection_id = pm_connections.id
                  AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id())));
--> statement-breakpoint
DROP POLICY IF EXISTS "pm_imported_work_items_context_graph_read" ON "pm_imported_work_items";
--> statement-breakpoint
CREATE POLICY "pm_imported_work_items_context_graph_read" ON "pm_imported_work_items" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND EXISTS (SELECT 1 FROM context_graph_nodes n
                WHERE n.pm_imported_work_item_id = pm_imported_work_items.id
                  AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id())));
--> statement-breakpoint

ALTER TABLE "context_graph_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_nodes_admin" ON "context_graph_nodes";
--> statement-breakpoint
CREATE POLICY "context_graph_nodes_admin" ON "context_graph_nodes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_nodes_reader" ON "context_graph_nodes";
--> statement-breakpoint
CREATE POLICY "context_graph_nodes_reader" ON "context_graph_nodes" FOR SELECT
  USING (regulait_context_graph_node_readable("id", regulait_rls_user_id()));
--> statement-breakpoint

ALTER TABLE "context_graph_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_edges_admin" ON "context_graph_edges";
--> statement-breakpoint
CREATE POLICY "context_graph_edges_admin" ON "context_graph_edges" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_edges_reader" ON "context_graph_edges";
--> statement-breakpoint
CREATE POLICY "context_graph_edges_reader" ON "context_graph_edges" FOR SELECT
  USING (regulait_context_graph_node_readable("from_node_id", regulait_rls_user_id())
    AND regulait_context_graph_node_readable("to_node_id", regulait_rls_user_id()));
--> statement-breakpoint

ALTER TABLE "context_graph_node_scopes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_node_scopes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_node_scopes_admin" ON "context_graph_node_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_scopes_admin" ON "context_graph_node_scopes" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_node_scopes_membership" ON "context_graph_node_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_scopes_membership" ON "context_graph_node_scopes" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'rls_membership');
--> statement-breakpoint
-- the node list starts from the caller's memberships: under context_graph_read, the scope rows of the principal's own
-- projects only (review R4 finding 1); the readable function still decides each node
DROP POLICY IF EXISTS "context_graph_node_scopes_own_projects" ON "context_graph_node_scopes";
--> statement-breakpoint
CREATE POLICY "context_graph_node_scopes_own_projects" ON "context_graph_node_scopes" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND project_id IN (SELECT m.project_id FROM project_members m
                       JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
                       WHERE m.user_id = (SELECT regulait_rls_user_id())));
