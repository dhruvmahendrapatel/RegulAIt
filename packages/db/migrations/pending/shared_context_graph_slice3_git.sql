-- ADR-0365 slice 3 (lane E46): a git source for the context graph (repositories and pull requests), with a project
-- scope per repository. Hand-authored (never drizzle-kit generate), additive and idempotent. The file name sorts after
-- `shared_context_graph_runs.sql` (byte order: 'sl' > 'ru'), whose node kind CHECK it widens again. It adds no system
-- reason (so it does not redefine regulait_rls_system_reason()) and no function, and it leaves
-- regulait_context_graph_node_readable unchanged: that function still reads only the scope tables.
--
-- What changes:
--   context_graph_git_sources        one row per discovery repo source (ADR-0195) an admin bound into the graph. The
--                                    credential, guarded fetch and write-scope refusal are the discovery source's; no
--                                    token is stored here.
--   context_graph_git_repo_mappings  the per-repository scope: (git source, repository full name) -> project. Strict
--                                    default: a repository with no row is never projected, so no fact or node exists
--                                    for it. Deleting the row cascades to its facts and nodes.
--   context_graph_git_repositories   a mapped repository as the provider last listed it (verbatim external payload),
--                                    referencing its mapping row (composite foreign key, cascade).
--   context_graph_git_pull_requests  a pull request of a mapped repository (number, title, normalised state, https URL,
--                                    provider times). No author or other identity is stored.
--   context_graph_nodes              two kinds, `git_repository` and `git_pull_request`, each with a foreign key to its
--                                    fact row (cascade); `source_id` (the PM source) becomes NULL for them, and the kind
--                                    CHECK says which reference each kind carries.
--   context_graph_edges              no change: a repository `contains` its pull requests.
--
-- Row-level security, ENABLED and FORCED on the four new tables:
--   - an active admin, `migration` and `system_task` (the scheduled sync) for every command on the git source, the
--     repository and the pull request tables; on the mappings `system_task` only reads (the sync never maps).
--   - under `context_graph_read` (the node read routes' principal step), SELECT only, and only the rows a node the
--     principal may read refers to (security review finding on #1092: never a whole table under that reason): a
--     pull request through its node; a repository through its node or a readable pull request node of it; a git
--     source through a readable node of one of its repositories. The mappings are never opened under it.
-- Deleting a discovery source, a git source, a mapping or a project cascades (referential actions bypass row-level
-- security).

CREATE TABLE IF NOT EXISTS "context_graph_git_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "discovery_source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "bound_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "bound_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_git_sources_discovery_uq" ON "context_graph_git_sources" ("discovery_source_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_git_repo_mappings" (
  "git_source_id" uuid NOT NULL REFERENCES "context_graph_git_sources"("id") ON DELETE CASCADE,
  "full_name" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "mapped_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "mapped_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "context_graph_git_repo_mappings_pk" PRIMARY KEY ("git_source_id", "full_name"),
  CONSTRAINT "context_graph_git_repo_mappings_name_check" CHECK (char_length("full_name") BETWEEN 3 AND 1024)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_graph_git_repo_mappings_project_idx" ON "context_graph_git_repo_mappings" ("project_id");
--> statement-breakpoint
-- providers treat repository names case-insensitively: one mapping per name whatever its case
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_git_repo_mappings_name_ci_uq" ON "context_graph_git_repo_mappings" ("git_source_id", lower("full_name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_git_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "git_source_id" uuid NOT NULL,
  "full_name" text NOT NULL,
  "default_branch" text,
  "archived" boolean DEFAULT false NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "missing_since" timestamp with time zone,
  CONSTRAINT "context_graph_git_repositories_mapping_fk" FOREIGN KEY ("git_source_id", "full_name")
    REFERENCES "context_graph_git_repo_mappings"("git_source_id", "full_name") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_git_repositories_source_name_uq" ON "context_graph_git_repositories" ("git_source_id", "full_name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "context_graph_git_pull_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL REFERENCES "context_graph_git_repositories"("id") ON DELETE CASCADE,
  "number" integer NOT NULL,
  "title" text NOT NULL,
  "state" text NOT NULL,
  "url" text,
  "provider_created_at" timestamp with time zone,
  "provider_updated_at" timestamp with time zone,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "missing_since" timestamp with time zone,
  CONSTRAINT "context_graph_git_pull_requests_number_check" CHECK ("number" > 0),
  CONSTRAINT "context_graph_git_pull_requests_state_check" CHECK ("state" IN ('open', 'merged', 'closed')),
  CONSTRAINT "context_graph_git_pull_requests_title_check" CHECK (char_length("title") BETWEEN 1 AND 500),
  CONSTRAINT "context_graph_git_pull_requests_url_check" CHECK ("url" IS NULL OR ("url" LIKE 'https://%' AND char_length("url") <= 2048))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_git_pull_requests_repo_number_uq" ON "context_graph_git_pull_requests" ("repository_id", "number");
--> statement-breakpoint

-- the two git node kinds: each references its fact row; a git node has no PM source
ALTER TABLE "context_graph_nodes" ADD COLUMN IF NOT EXISTS "git_repository_id" uuid
  REFERENCES "context_graph_git_repositories"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" ADD COLUMN IF NOT EXISTS "git_pull_request_id" uuid
  REFERENCES "context_graph_git_pull_requests"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" ALTER COLUMN "source_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" DROP CONSTRAINT IF EXISTS "context_graph_nodes_kind_check";
--> statement-breakpoint
ALTER TABLE "context_graph_nodes" ADD CONSTRAINT "context_graph_nodes_kind_check" CHECK (CASE "kind"
  WHEN 'pm_project' THEN "source_id" IS NOT NULL AND "pm_imported_work_item_id" IS NULL AND "orchestration_run_id" IS NULL
    AND "git_repository_id" IS NULL AND "git_pull_request_id" IS NULL
  WHEN 'pm_work_item' THEN "source_id" IS NOT NULL AND "pm_imported_work_item_id" IS NOT NULL AND "orchestration_run_id" IS NULL
    AND "git_repository_id" IS NULL AND "git_pull_request_id" IS NULL
  WHEN 'orchestration_run' THEN "source_id" IS NOT NULL AND "orchestration_run_id" IS NOT NULL AND "pm_imported_work_item_id" IS NULL
    AND "git_repository_id" IS NULL AND "git_pull_request_id" IS NULL
  WHEN 'git_repository' THEN "source_id" IS NULL AND "git_repository_id" IS NOT NULL AND "pm_imported_work_item_id" IS NULL
    AND "orchestration_run_id" IS NULL AND "git_pull_request_id" IS NULL
  WHEN 'git_pull_request' THEN "source_id" IS NULL AND "git_pull_request_id" IS NOT NULL AND "pm_imported_work_item_id" IS NULL
    AND "orchestration_run_id" IS NULL AND "git_repository_id" IS NULL
  ELSE false END);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_nodes_git_repository_uq" ON "context_graph_nodes" ("git_repository_id") WHERE "git_repository_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_graph_nodes_git_pull_request_uq" ON "context_graph_nodes" ("git_pull_request_id") WHERE "git_pull_request_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "context_graph_git_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_sources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_repo_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_repo_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_repositories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_repositories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_pull_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_graph_git_pull_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "context_graph_git_sources_admin" ON "context_graph_git_sources";
--> statement-breakpoint
CREATE POLICY "context_graph_git_sources_admin" ON "context_graph_git_sources" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_git_repo_mappings_admin" ON "context_graph_git_repo_mappings";
--> statement-breakpoint
CREATE POLICY "context_graph_git_repo_mappings_admin" ON "context_graph_git_repo_mappings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint
-- the scheduled sync reads the mappings (which repositories to project, and into which project); it never writes them
DROP POLICY IF EXISTS "context_graph_git_repo_mappings_sync" ON "context_graph_git_repo_mappings";
--> statement-breakpoint
CREATE POLICY "context_graph_git_repo_mappings_sync" ON "context_graph_git_repo_mappings" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'system_task');
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_git_repositories_admin" ON "context_graph_git_repositories";
--> statement-breakpoint
CREATE POLICY "context_graph_git_repositories_admin" ON "context_graph_git_repositories" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_git_pull_requests_admin" ON "context_graph_git_pull_requests";
--> statement-breakpoint
CREATE POLICY "context_graph_git_pull_requests_admin" ON "context_graph_git_pull_requests" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration', 'system_task']));
--> statement-breakpoint

-- the joined facts of a readable git node, under the context_graph_read principal step: read only, and only the rows a
-- node the principal may read refers to (the readable function decides; it reads only the scope tables)
DROP POLICY IF EXISTS "context_graph_git_pull_requests_read" ON "context_graph_git_pull_requests";
--> statement-breakpoint
CREATE POLICY "context_graph_git_pull_requests_read" ON "context_graph_git_pull_requests" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND EXISTS (SELECT 1 FROM context_graph_nodes n
                WHERE n.git_pull_request_id = context_graph_git_pull_requests.id
                  AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id())));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_git_repositories_read" ON "context_graph_git_repositories";
--> statement-breakpoint
CREATE POLICY "context_graph_git_repositories_read" ON "context_graph_git_repositories" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND (EXISTS (SELECT 1 FROM context_graph_nodes n
                 WHERE n.git_repository_id = context_graph_git_repositories.id
                   AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id()))
      OR EXISTS (SELECT 1 FROM context_graph_git_pull_requests p
                 JOIN context_graph_nodes n ON n.git_pull_request_id = p.id
                 WHERE p.repository_id = context_graph_git_repositories.id
                   AND regulait_context_graph_node_readable(n.id, regulait_rls_user_id()))));
--> statement-breakpoint
DROP POLICY IF EXISTS "context_graph_git_sources_read" ON "context_graph_git_sources";
--> statement-breakpoint
CREATE POLICY "context_graph_git_sources_read" ON "context_graph_git_sources" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'context_graph_read'
    AND EXISTS (SELECT 1 FROM context_graph_git_repositories r
                WHERE r.git_source_id = context_graph_git_sources.id));
