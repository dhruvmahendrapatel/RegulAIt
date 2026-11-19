-- ADR-0339 addendum (lane E20): mark an agent for a risk recompute when one of its CAPABILITY inputs changes, so the
-- capability combinations (lethal trifecta; untrusted input + unconfirmed destructive action) stay current on every
-- change, as ADR-0339 decision 2 requires, not only at the daily mark.
--
-- Trigger-only and additive: no table, column or route. Every function pins its search_path (zz-dbguard-0185) and
-- writes only through `regulait_agent_risk_mark` (pending/agent_risk_scores.sql). Named to sort after it and after pending/connector_disable.sql, whose `disabled_at` column the connectors trigger watches. Marks (all 'evidence_changed', except
-- an identity's own grants, which are 'access_changed'):
--   - mcp_tools: a new tool (a whole-server grant holds it at once), a change of kind or dangerous (as well as the
--     existing name/server/delete), for the builder agents bound to the tool AND the registry agents whose identity
--     holds it (a tool grant or a server grant);
--   - connectors: provider_kind or disabled_at, for the builder agents bound to it and the identities granted it;
--   - content_trust_tiers (ADR-0193): any change, for every holder of the classified server's tools or the connector;
--   - mcp_definition_pins: a tool's approved definition changing (its annotations), for the holders of that tool;
--   - identity_tool_grants, identity_server_grants, identity_connector_grants, identity_role_assignments and
--     workload_identities (status, agent): the identity's agent; role_tool_grants, role_server_grants and
--     role_connector_grants: the agents whose identity holds the role.
-- Hand-authored, idempotent.

-- the holders of an MCP server's tools (one named tool, or all of them when p_tool is NULL) and of a connector
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_mark_holders(p_server uuid, p_tool text, p_connector uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  IF p_server IS NOT NULL THEN
    FOR r IN
      SELECT DISTINCT bt."agent_id" FROM public.builder_agent_tools bt
        JOIN public.mcp_tools t ON t."id" = bt."ref_id"
        WHERE bt."kind" = 'mcp_tool' AND t."server_id" = p_server AND (p_tool IS NULL OR t."name" = p_tool)
    LOOP
      PERFORM public.regulait_agent_risk_mark(NULL, r."agent_id", 'evidence_changed');
    END LOOP;
    FOR r IN
      SELECT DISTINCT w."agent_id", w."builder_agent_id" FROM public.workload_identities w
        WHERE w."id" IN (
          SELECT g."identity_id" FROM public.identity_tool_grants g WHERE g."server_id" = p_server AND (p_tool IS NULL OR g."tool_name" = p_tool)
          UNION SELECT g."identity_id" FROM public.identity_server_grants g WHERE g."server_id" = p_server
          UNION SELECT a."identity_id" FROM public.identity_role_assignments a
            JOIN public.role_tool_grants g ON g."role_id" = a."role_id"
            WHERE g."server_id" = p_server AND (p_tool IS NULL OR g."tool_name" = p_tool)
          UNION SELECT a."identity_id" FROM public.identity_role_assignments a
            JOIN public.role_server_grants g ON g."role_id" = a."role_id" WHERE g."server_id" = p_server)
    LOOP
      PERFORM public.regulait_agent_risk_mark(r."agent_id", r."builder_agent_id", 'evidence_changed');
    END LOOP;
  END IF;
  IF p_connector IS NOT NULL THEN
    FOR r IN SELECT DISTINCT bt."agent_id" FROM public.builder_agent_tools bt WHERE bt."kind" = 'connector' AND bt."ref_id" = p_connector LOOP
      PERFORM public.regulait_agent_risk_mark(NULL, r."agent_id", 'evidence_changed');
    END LOOP;
    FOR r IN
      SELECT DISTINCT w."agent_id", w."builder_agent_id" FROM public.workload_identities w
        WHERE w."id" IN (
          SELECT g."identity_id" FROM public.identity_connector_grants g WHERE g."connector_id" = p_connector
          UNION SELECT a."identity_id" FROM public.identity_role_assignments a
            JOIN public.role_connector_grants g ON g."role_id" = a."role_id" WHERE g."connector_id" = p_connector)
    LOOP
      PERFORM public.regulait_agent_risk_mark(r."agent_id", r."builder_agent_id", 'evidence_changed');
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
-- mcp_tools: the existing trigger now also fires on a new tool, kind and dangerous, and marks identity holders too
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_mcp_tool() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    FOR r IN SELECT t."agent_id" FROM public.builder_agent_tools t WHERE t."kind" = 'mcp_tool' AND t."ref_id" = OLD."id" LOOP
      PERFORM public.regulait_agent_risk_mark(NULL, r."agent_id", 'evidence_changed');
    END LOOP;
    PERFORM public.regulait_agent_risk_mark_holders(OLD."server_id", OLD."name", NULL);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.regulait_agent_risk_mark_holders(NEW."server_id", NEW."name", NULL);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_tools_risk_mark" ON "mcp_tools";
--> statement-breakpoint
CREATE TRIGGER "mcp_tools_risk_mark" AFTER INSERT OR UPDATE OF "server_id", "name", "kind", "dangerous" OR DELETE ON "mcp_tools"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_mcp_tool();
--> statement-breakpoint
-- connectors: what they can do (provider) and whether they are live
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_connector() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.regulait_agent_risk_mark_holders(NULL, NULL, NEW."id");
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "connectors_risk_mark" ON "connectors";
--> statement-breakpoint
CREATE TRIGGER "connectors_risk_mark" AFTER UPDATE OF "provider_kind", "disabled_at" ON "connectors"
  FOR EACH ROW WHEN (OLD."provider_kind" IS DISTINCT FROM NEW."provider_kind" OR OLD."disabled_at" IS DISTINCT FROM NEW."disabled_at")
  EXECUTE FUNCTION public.regulait_agent_risk_on_connector();
--> statement-breakpoint
-- ADR-0193 content-trust tiers: a source classified, reclassified or unclassified
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_trust_tier() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text := COALESCE(NEW."source_kind", OLD."source_kind");
  s uuid := COALESCE(NEW."source_id", OLD."source_id");
BEGIN
  IF k = 'mcp_server' THEN
    PERFORM public.regulait_agent_risk_mark_holders(s, NULL, NULL);
  ELSIF k = 'connector' THEN
    PERFORM public.regulait_agent_risk_mark_holders(NULL, NULL, s);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_trust_tiers_risk_mark" ON "content_trust_tiers";
--> statement-breakpoint
CREATE TRIGGER "content_trust_tiers_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "content_trust_tiers"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_trust_tier();
--> statement-breakpoint
-- a tool's admitted definition (its MCP annotations) changing
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_definition_pin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF COALESCE(NEW."kind", OLD."kind") = 'tool' THEN
    PERFORM public.regulait_agent_risk_mark_holders(COALESCE(NEW."server_id", OLD."server_id"), COALESCE(NEW."name", OLD."name"), NULL);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_definition_pins_risk_mark" ON "mcp_definition_pins";
--> statement-breakpoint
CREATE TRIGGER "mcp_definition_pins_risk_mark" AFTER INSERT OR UPDATE OF "approved_digest" OR DELETE ON "mcp_definition_pins"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_definition_pin();
--> statement-breakpoint
-- an identity's own grants and roles: the identity's agent
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_identity_grant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT w."agent_id", w."builder_agent_id" FROM public.workload_identities w
      WHERE w."id" IN ((to_jsonb(OLD) ->> 'identity_id')::uuid, (to_jsonb(NEW) ->> 'identity_id')::uuid)
  LOOP
    PERFORM public.regulait_agent_risk_mark(r."agent_id", r."builder_agent_id", 'access_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_tool_grants_risk_mark" ON "identity_tool_grants";
--> statement-breakpoint
CREATE TRIGGER "identity_tool_grants_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "identity_tool_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_server_grants_risk_mark" ON "identity_server_grants";
--> statement-breakpoint
CREATE TRIGGER "identity_server_grants_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "identity_server_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_connector_grants_risk_mark" ON "identity_connector_grants";
--> statement-breakpoint
CREATE TRIGGER "identity_connector_grants_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "identity_connector_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_role_assignments_risk_mark" ON "identity_role_assignments";
--> statement-breakpoint
CREATE TRIGGER "identity_role_assignments_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "identity_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_grant();
--> statement-breakpoint
-- an identity created, activated, suspended or moved to another agent: both agents
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_workload_identity() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.regulait_agent_risk_mark(OLD."agent_id", OLD."builder_agent_id", 'access_changed');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.regulait_agent_risk_mark(NEW."agent_id", NEW."builder_agent_id", 'access_changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workload_identities_risk_mark" ON "workload_identities";
--> statement-breakpoint
CREATE TRIGGER "workload_identities_risk_mark" AFTER INSERT OR UPDATE OF "status", "agent_id", "builder_agent_id" OR DELETE ON "workload_identities"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_workload_identity();
--> statement-breakpoint
-- a role's tool, server or connector grants changing: the agents whose identity holds the role
CREATE OR REPLACE FUNCTION public.regulait_agent_risk_on_identity_role_grant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT w."agent_id", w."builder_agent_id" FROM public.identity_role_assignments a
      JOIN public.workload_identities w ON w."id" = a."identity_id"
      WHERE a."role_id" IN ((to_jsonb(OLD) ->> 'role_id')::uuid, (to_jsonb(NEW) ->> 'role_id')::uuid)
  LOOP
    PERFORM public.regulait_agent_risk_mark(r."agent_id", r."builder_agent_id", 'access_changed');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_tool_grants_identity_risk_mark" ON "role_tool_grants";
--> statement-breakpoint
CREATE TRIGGER "role_tool_grants_identity_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "role_tool_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_role_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_server_grants_identity_risk_mark" ON "role_server_grants";
--> statement-breakpoint
CREATE TRIGGER "role_server_grants_identity_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "role_server_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_role_grant();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "role_connector_grants_identity_risk_mark" ON "role_connector_grants";
--> statement-breakpoint
CREATE TRIGGER "role_connector_grants_identity_risk_mark" AFTER INSERT OR UPDATE OR DELETE ON "role_connector_grants"
  FOR EACH ROW EXECUTE FUNCTION public.regulait_agent_risk_on_identity_role_grant();
