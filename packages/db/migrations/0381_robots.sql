-- ADR-0364 (lane E45 S2): governed RPA "Robots". Hand-authored (never drizzle-kit generate), additive and idempotent.
--
-- Tables: robots, robot_versions, robot_version_allowed_sites, robot_version_editors, robot_secrets, robot_version_secrets, robot_runs.
-- Third normal form: the allow-list and the secret bindings are join tables; a version binds only its own robot's
-- secrets, and only on one of its own allowed sites, by composite foreign keys. "Used by N agents" and the list's
-- status are computed on read, never stored. Exceptions, commented on the column in schema.ts: the script and the two
-- JSON schemas (the reviewed artefact and schema-validated configuration documents, frozen once submitted).
--
-- Triggers: a version's content (and its allow-list and bindings) is frozen once its status leaves 'draft', so what
-- the reviewer approved is what runs (ADR-0364 §3). Both trigger functions pin search_path (zz-dbguard-0185).
--
-- The Robots MCP server: mcp_servers.transport gains 'first_party' (a server the gateway serves in-process; the org
-- enable-list `mcp_upstream_transports` is unchanged and can never name it), and the one first-party row is seeded.
--
-- Secure by default (ADR-0180, ADR-0234): row-level security ENABLED and FORCED on every new table.
--  - robots, robot_versions, robot_version_allowed_sites, robot_version_secrets: any signed-in principal may READ
--    (the gateway's object-level checks decide who sees what: the owner, an admin, the named approver, and people
--    entitled to an approved version's tool); only the robot's owner or an admin may write, plus the named approver
--    or decider of the version's approval for the decision's own update.
--  - robot_secrets: the owner, an admin and the runner (system_task) only, for read and write. The ciphertext never
--    leaves the gateway (no route returns it).
--  - robot_runs: the requester, the robot's owner, an admin and system_task.
-- Enter the migration system context (ADR-0234): this file's policy and trigger bodies name an RLS table, so the
-- RLS-slice-1 guard (zz-adr0234-rls-slice1.test.ts) requires it once the file is numbered; transaction-local, and
-- cleared again at the end of the file.
SELECT set_config('regulait.system_context', 'migration', true);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "engine" text DEFAULT 'browser' NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "status" text DEFAULT 'active' NOT NULL,
  "model_fallback" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone,
  CONSTRAINT "robots_slug_check" CHECK ("slug" ~ '^[a-z0-9_]{1,48}$'),
  CONSTRAINT "robots_name_check" CHECK (length("name") BETWEEN 1 AND 120),
  CONSTRAINT "robots_engine_check" CHECK ("engine" IN ('browser', 'desktop')),
  CONSTRAINT "robots_status_check" CHECK ("status" IN ('active', 'retired')),
  CONSTRAINT "robots_retired_shape" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robots_slug_uq" ON "robots" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robots_owner_idx" ON "robots" ("owner_user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "robot_id" uuid NOT NULL REFERENCES "robots"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "source" text DEFAULT 'recorded' NOT NULL,
  "script_format" text DEFAULT 'steps_v1' NOT NULL,
  "script" text NOT NULL,
  "script_sha256" text NOT NULL,
  "compiled_sha256" text,
  "compiler_version" text,
  "content_digest" text,
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb NOT NULL,
  "author_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "drafted_by_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE RESTRICT,
  "mcp_tool_id" uuid REFERENCES "mcp_tools"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  CONSTRAINT "robot_versions_version_check" CHECK ("version" BETWEEN 1 AND 100000),
  CONSTRAINT "robot_versions_status_check" CHECK ("status" IN ('draft', 'in_review', 'approved', 'rejected', 'retired')),
  CONSTRAINT "robot_versions_source_check" CHECK ("source" IN ('recorded', 'uploaded', 'agent_drafted')),
  CONSTRAINT "robot_versions_format_check" CHECK ("script_format" IN ('steps_v1', 'playwright_ts', 'robot_framework')),
  CONSTRAINT "robot_versions_sha_check" CHECK ("script_sha256" ~ '^[0-9a-f]{64}$'
    AND ("compiled_sha256" IS NULL OR "compiled_sha256" ~ '^[0-9a-f]{64}$')
    AND ("content_digest" IS NULL OR "content_digest" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "robot_versions_script_size_check" CHECK (octet_length("script") <= 262144),
  -- a submitted version carries its digest and its approval; an approved one carries its tool. A draft rejected
  -- because its robot was retired was never submitted, so it carries neither.
  CONSTRAINT "robot_versions_submitted_shape" CHECK ("status" = 'draft'
    OR ("status" = 'rejected' AND "submitted_at" IS NULL)
    OR ("content_digest" IS NOT NULL AND "submitted_at" IS NOT NULL AND "approval_id" IS NOT NULL)),
  CONSTRAINT "robot_versions_tool_shape" CHECK ("status" NOT IN ('approved', 'retired') OR "mcp_tool_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robot_versions_robot_version_uq" ON "robot_versions" ("robot_id", "version");
--> statement-breakpoint
-- the composite foreign keys below need (id, robot_id) to be a key
CREATE UNIQUE INDEX IF NOT EXISTS "robot_versions_id_robot_uq" ON "robot_versions" ("id", "robot_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robot_versions_approval_uq" ON "robot_versions" ("approval_id") WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robot_versions_tool_uq" ON "robot_versions" ("mcp_tool_id") WHERE "mcp_tool_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_versions_status_idx" ON "robot_versions" ("status", "robot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_version_allowed_sites" (
  "robot_version_id" uuid NOT NULL REFERENCES "robot_versions"("id") ON DELETE CASCADE,
  "origin" text NOT NULL,
  CONSTRAINT "robot_version_allowed_sites_pk" PRIMARY KEY ("robot_version_id", "origin"),
  CONSTRAINT "robot_version_allowed_sites_origin_check" CHECK ("origin" ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$' AND length("origin") <= 300)
);
--> statement-breakpoint
-- Everyone who wrote a version's content while it was a draft (its author and every editor), so the decide path can
-- refuse each of them, not only the author (separation of duties, ADR-0364 §3). A join table, frozen with the version.
CREATE TABLE IF NOT EXISTS "robot_version_editors" (
  "robot_version_id" uuid NOT NULL REFERENCES "robot_versions"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "first_edited_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "robot_version_editors_pk" PRIMARY KEY ("robot_version_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_version_editors_user_idx" ON "robot_version_editors" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "robot_id" uuid NOT NULL REFERENCES "robots"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "scope" text NOT NULL,
  "value_ciphertext" text NOT NULL,
  "last4" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "robot_secrets_name_check" CHECK ("name" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  CONSTRAINT "robot_secrets_scope_check" CHECK ("scope" IN ('live', 'test')),
  CONSTRAINT "robot_secrets_last4_check" CHECK (length("last4") <= 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robot_secrets_name_scope_uq" ON "robot_secrets" ("robot_id", "name", "scope");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "robot_secrets_id_robot_uq" ON "robot_secrets" ("id", "robot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_version_secrets" (
  -- a row id for the ADR-0233 existing-rows report (it keys every guarded table by `id`); the key is (version, name)
  "id" uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  "robot_version_id" uuid NOT NULL,
  "robot_id" uuid NOT NULL,
  "name" text NOT NULL,
  "origin" text NOT NULL,
  "live_secret_id" uuid,
  "test_secret_id" uuid,
  CONSTRAINT "robot_version_secrets_pk" PRIMARY KEY ("robot_version_id", "name"),
  CONSTRAINT "robot_version_secrets_version_fk" FOREIGN KEY ("robot_version_id", "robot_id")
    REFERENCES "robot_versions"("id", "robot_id") ON DELETE CASCADE,
  CONSTRAINT "robot_version_secrets_site_fk" FOREIGN KEY ("robot_version_id", "origin")
    REFERENCES "robot_version_allowed_sites"("robot_version_id", "origin") ON DELETE CASCADE,
  CONSTRAINT "robot_version_secrets_live_fk" FOREIGN KEY ("live_secret_id", "robot_id")
    REFERENCES "robot_secrets"("id", "robot_id") ON DELETE RESTRICT,
  CONSTRAINT "robot_version_secrets_test_fk" FOREIGN KEY ("test_secret_id", "robot_id")
    REFERENCES "robot_secrets"("id", "robot_id") ON DELETE RESTRICT,
  CONSTRAINT "robot_version_secrets_name_check" CHECK ("name" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "robot_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "robot_version_id" uuid NOT NULL REFERENCES "robot_versions"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE SET NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  -- point-in-time: the digest the run executed, so a test run proves exactly one version content
  "content_digest" text NOT NULL,
  "step_count" integer,
  "duration_ms" integer,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "robot_runs_kind_check" CHECK ("kind" IN ('test', 'agent', 'freeform')),
  CONSTRAINT "robot_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'refused')),
  CONSTRAINT "robot_runs_digest_check" CHECK ("content_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "robot_runs_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[a-z_]{1,64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "robot_runs_version_idx" ON "robot_runs" ("robot_version_id", "status", "content_digest");
--> statement-breakpoint
-- Freeze a version's content once it leaves 'draft'. Status, approval, tool and timestamps stay writable.
CREATE OR REPLACE FUNCTION regulait_robot_version_freeze() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- the status moves only along ROBOT_VERSION_MACHINE's edges (packages/shared/src/state-machines.ts): a version is
  -- never moved back to draft, which would otherwise reopen its content and its child rows to edits
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('in_review', 'rejected'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'robot version % cannot move from % to % (ADR-0364 §8)', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.script IS DISTINCT FROM OLD.script OR NEW.script_format IS DISTINCT FROM OLD.script_format
    OR NEW.script_sha256 IS DISTINCT FROM OLD.script_sha256 OR NEW.compiled_sha256 IS DISTINCT FROM OLD.compiled_sha256
    OR NEW.compiler_version IS DISTINCT FROM OLD.compiler_version OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
    OR NEW.input_schema IS DISTINCT FROM OLD.input_schema OR NEW.output_schema IS DISTINCT FROM OLD.output_schema
    OR NEW.robot_id IS DISTINCT FROM OLD.robot_id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR NEW.source IS DISTINCT FROM OLD.source) THEN
    RAISE EXCEPTION 'robot version % is % and its content is frozen (ADR-0364 §3)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS robot_versions_freeze ON "robot_versions";
--> statement-breakpoint
CREATE TRIGGER robot_versions_freeze BEFORE UPDATE ON "robot_versions" FOR EACH ROW EXECUTE FUNCTION regulait_robot_version_freeze();
--> statement-breakpoint
-- The allow-list and the bindings of a submitted version cannot change either.
CREATE OR REPLACE FUNCTION regulait_robot_version_child_freeze() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM robot_versions
   WHERE id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.robot_version_id ELSE NEW.robot_version_id END);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'robot version is % and its allow-list and secret bindings are frozen (ADR-0364 §3)', v_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.robot_version_id IS DISTINCT FROM OLD.robot_version_id THEN
    RAISE EXCEPTION 'a row cannot move to another robot version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS robot_version_allowed_sites_freeze ON "robot_version_allowed_sites";
--> statement-breakpoint
CREATE TRIGGER robot_version_allowed_sites_freeze BEFORE INSERT OR UPDATE OR DELETE ON "robot_version_allowed_sites"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_version_child_freeze();
--> statement-breakpoint
DROP TRIGGER IF EXISTS robot_version_editors_freeze ON "robot_version_editors";
--> statement-breakpoint
CREATE TRIGGER robot_version_editors_freeze BEFORE INSERT OR UPDATE OR DELETE ON "robot_version_editors"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_version_child_freeze();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "robot_version_editors_no_truncate" ON public."robot_version_editors";
--> statement-breakpoint
CREATE TRIGGER "robot_version_editors_no_truncate" BEFORE TRUNCATE ON public."robot_version_editors"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS robot_version_secrets_freeze ON "robot_version_secrets";
--> statement-breakpoint
CREATE TRIGGER robot_version_secrets_freeze BEFORE INSERT OR UPDATE OR DELETE ON "robot_version_secrets"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_version_child_freeze();
--> statement-breakpoint
-- A binding's live secret must be a live one and its test secret a test one.
CREATE OR REPLACE FUNCTION regulait_robot_binding_scope() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.live_secret_id IS NOT NULL AND (SELECT scope FROM robot_secrets WHERE id = NEW.live_secret_id) <> 'live' THEN
    RAISE EXCEPTION 'a binding''s live secret must have scope live' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.test_secret_id IS NOT NULL AND (SELECT scope FROM robot_secrets WHERE id = NEW.test_secret_id) <> 'test' THEN
    RAISE EXCEPTION 'a binding''s test secret must have scope test' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A row-level freeze trigger is useless against TRUNCATE (migration 0185's invariant): refuse it too.
DROP TRIGGER IF EXISTS "robot_versions_no_truncate" ON public."robot_versions";
--> statement-breakpoint
CREATE TRIGGER "robot_versions_no_truncate" BEFORE TRUNCATE ON public."robot_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
-- A row-level freeze trigger is useless against TRUNCATE (migration 0185's invariant): refuse it too.
DROP TRIGGER IF EXISTS "robot_version_allowed_sites_no_truncate" ON public."robot_version_allowed_sites";
--> statement-breakpoint
CREATE TRIGGER "robot_version_allowed_sites_no_truncate" BEFORE TRUNCATE ON public."robot_version_allowed_sites"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
-- A row-level freeze trigger is useless against TRUNCATE (migration 0185's invariant): refuse it too.
DROP TRIGGER IF EXISTS "robot_version_secrets_no_truncate" ON public."robot_version_secrets";
--> statement-breakpoint
CREATE TRIGGER "robot_version_secrets_no_truncate" BEFORE TRUNCATE ON public."robot_version_secrets"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS robot_version_secrets_scope ON "robot_version_secrets";
--> statement-breakpoint
CREATE TRIGGER robot_version_secrets_scope BEFORE INSERT OR UPDATE ON "robot_version_secrets"
  FOR EACH ROW EXECUTE FUNCTION regulait_robot_binding_scope();
--> statement-breakpoint
-- The Robots MCP server (ADR-0364 §2): 'first_party' joins the transport CHECK, and the one row is seeded.
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_transport_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_check"
  CHECK ("transport" IN ('streamable_http', 'sse', 'stdio', 'first_party'));
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_first_party_url_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_first_party_url_check"
  CHECK (("transport" = 'first_party') = ("url" LIKE 'regulait:%'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_first_party_url_uq" ON "mcp_servers" ("url") WHERE "transport" = 'first_party';
--> statement-breakpoint
-- The one first-party row. Its code ships inside the gateway release the operator installed, so the ADR-0175
-- release-age cooldown does not apply to it (`serverReleaseStatus` exempts a first-party server on the gateway's fixed
-- list); every tool it serves is a robot version that passed its own review (ADR-0364 §3).
INSERT INTO "mcp_servers" ("name", "url", "transport")
  SELECT 'RegulAIt Robots', 'regulait:robots', 'first_party'
  WHERE NOT EXISTS (SELECT 1 FROM "mcp_servers" WHERE "url" = 'regulait:robots');
--> statement-breakpoint
ALTER TABLE "robots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_editors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_editors" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_allowed_sites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_allowed_sites" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_version_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "robot_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- robots
DROP POLICY IF EXISTS robots_select ON "robots";
--> statement-breakpoint
CREATE POLICY robots_select ON "robots" FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS robots_insert ON "robots";
--> statement-breakpoint
CREATE POLICY robots_insert ON "robots" FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR "owner_user_id" = (SELECT regulait_rls_user_id())
  OR (SELECT regulait_rls_system_reason()) = 'migration'
);
--> statement-breakpoint
DROP POLICY IF EXISTS robots_update ON "robots";
--> statement-breakpoint
CREATE POLICY robots_update ON "robots" FOR UPDATE
  USING ((SELECT regulait_rls_is_admin()) OR "owner_user_id" = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_system_reason()) = 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR "owner_user_id" = (SELECT regulait_rls_user_id())
    OR (SELECT regulait_rls_system_reason()) = 'migration');
--> statement-breakpoint
-- robot_versions: the owner or an admin writes; the named approver or decider of the version's approval may apply
-- the decision (approve or reject: status, tool, decided_at; the freeze trigger keeps the content as it was)
DROP POLICY IF EXISTS robot_versions_select ON "robot_versions";
--> statement-breakpoint
CREATE POLICY robot_versions_select ON "robot_versions" FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_versions_insert ON "robot_versions";
--> statement-breakpoint
CREATE POLICY robot_versions_insert ON "robot_versions" FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id()))
  OR (SELECT regulait_rls_system_reason()) = 'migration'
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_versions_update ON "robot_versions";
--> statement-breakpoint
CREATE POLICY robot_versions_update ON "robot_versions" FOR UPDATE
  USING (
    (SELECT regulait_rls_is_admin())
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id()))
    OR EXISTS (SELECT 1 FROM "approvals" a WHERE a."id" = "approval_id"
      AND (a."approver_user_id" = (SELECT regulait_rls_user_id()) OR a."decided_by" = (SELECT regulait_rls_user_id())))
    OR (SELECT regulait_rls_system_reason()) = 'migration'
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id()))
    OR EXISTS (SELECT 1 FROM "approvals" a WHERE a."id" = "approval_id"
      AND (a."approver_user_id" = (SELECT regulait_rls_user_id()) OR a."decided_by" = (SELECT regulait_rls_user_id())))
    OR (SELECT regulait_rls_system_reason()) = 'migration'
  );
--> statement-breakpoint
-- the two child tables: read like their version, written by the owner or an admin (and only while 'draft': trigger)
DROP POLICY IF EXISTS robot_version_allowed_sites_select ON "robot_version_allowed_sites";
--> statement-breakpoint
CREATE POLICY robot_version_allowed_sites_select ON "robot_version_allowed_sites" FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_version_allowed_sites_write ON "robot_version_allowed_sites";
--> statement-breakpoint
CREATE POLICY robot_version_allowed_sites_write ON "robot_version_allowed_sites" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robot_versions" v JOIN "robots" r ON r."id" = v."robot_id"
      WHERE v."id" = "robot_version_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robot_versions" v JOIN "robots" r ON r."id" = v."robot_id"
      WHERE v."id" = "robot_version_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())));
--> statement-breakpoint
DROP POLICY IF EXISTS robot_version_editors_select ON "robot_version_editors";
--> statement-breakpoint
CREATE POLICY robot_version_editors_select ON "robot_version_editors" FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_version_editors_write ON "robot_version_editors";
--> statement-breakpoint
CREATE POLICY robot_version_editors_write ON "robot_version_editors" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robot_versions" v JOIN "robots" r ON r."id" = v."robot_id"
      WHERE v."id" = "robot_version_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robot_versions" v JOIN "robots" r ON r."id" = v."robot_id"
      WHERE v."id" = "robot_version_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())));
--> statement-breakpoint
DROP POLICY IF EXISTS robot_version_secrets_select ON "robot_version_secrets";
--> statement-breakpoint
CREATE POLICY robot_version_secrets_select ON "robot_version_secrets" FOR SELECT USING (
  (SELECT regulait_rls_user_id()) IS NOT NULL
  OR (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_version_secrets_write ON "robot_version_secrets";
--> statement-breakpoint
CREATE POLICY robot_version_secrets_write ON "robot_version_secrets" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration'
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())));
--> statement-breakpoint
-- robot_secrets: never readable by anyone but the owner, an admin and the runner
DROP POLICY IF EXISTS robot_secrets_all ON "robot_secrets";
--> statement-breakpoint
CREATE POLICY robot_secrets_all ON "robot_secrets" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
    OR EXISTS (SELECT 1 FROM "robots" r WHERE r."id" = "robot_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id())));
--> statement-breakpoint
-- robot_runs: the requester, the robot's owner, an admin and the runner
DROP POLICY IF EXISTS robot_runs_select ON "robot_runs";
--> statement-breakpoint
CREATE POLICY robot_runs_select ON "robot_runs" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR "requested_by" = (SELECT regulait_rls_user_id())
  OR EXISTS (SELECT 1 FROM "robot_versions" v JOIN "robots" r ON r."id" = v."robot_id"
    WHERE v."id" = "robot_version_id" AND r."owner_user_id" = (SELECT regulait_rls_user_id()))
);
--> statement-breakpoint
DROP POLICY IF EXISTS robot_runs_write ON "robot_runs";
--> statement-breakpoint
CREATE POLICY robot_runs_write ON "robot_runs" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
SELECT set_config('regulait.system_context', '', true);
