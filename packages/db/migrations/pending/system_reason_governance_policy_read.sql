-- Named to sort after every pending migration that redefines regulait_rls_system_reason() (pending files are numbered
-- in byte order of their names), so this registry, which adds governance_policy_read, is the one that stands.
-- ADR-0357 §4 enforcement (owner decision D-2026-11-23-02, lane L1): the governed decision core reads the effective
-- inherited policy on every model, connector, MCP and A2A call. The caller is usually not an admin, and both tables
-- are admin-only (governance_policy_layers), so a call-path read would otherwise see NO rows and read as "no policy"
-- (fail open). The new system reason `governance_policy_read` opens both tables for SELECT only: no write, and no
-- other table. The gateway enters it for that one read and checks in the same transaction that it took effect, so a
-- read that could not see the rows refuses the call instead (fail closed).

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
                    'credential_request', 'pm_sync', 'context_graph_read', 'governance_policy_read']) THEN
    RETURN r;
  END IF;
  RAISE EXCEPTION 'regulait: unknown row-level security system context %', pg_catalog.quote_literal(r)
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint

DROP POLICY IF EXISTS business_units_governed_read ON "business_units";
--> statement-breakpoint
CREATE POLICY business_units_governed_read ON "business_units" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'governance_policy_read');
--> statement-breakpoint
DROP POLICY IF EXISTS governance_policy_layers_governed_read ON "governance_policy_layers";
--> statement-breakpoint
CREATE POLICY governance_policy_layers_governed_read ON "governance_policy_layers" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'governance_policy_read');
