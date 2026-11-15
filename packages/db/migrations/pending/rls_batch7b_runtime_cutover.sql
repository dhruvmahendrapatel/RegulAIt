-- ADR-0234 batch 7b (PENDING S7): the runtime login cut-over.
--
-- From this batch requests are served on a login that is a member of regulait_app and is not a superuser, BYPASSRLS
-- or the table owner (the gateway creates it at first boot, or an operator provides it). The owner (migrator) login
-- keeps the migrations and the one job that deletes from the ledger: the audit retention prune.
--
-- FORCE ROW LEVEL SECURITY binds the owner too, and audit_log had no DELETE policy, so an owner that is not a
-- superuser could not prune. A closed, owner-only reason is added for it:
--   audit_retention  the retention prune on the owner connection (the admin's POST /v1/audit/prune and the retention
--                    timer, both moved onto the owner pool): audit_log (read, delete).
--
-- The privilege boundary is the policy's role, not the reason: regulait.system_context is a session setting any login
-- may set, so a reason is a convention the gateway keeps, never a grant. The DELETE policy is therefore scoped TO the
-- table's owner (read from the catalogue: the migrator's name is not known to a migration), and the app role every
-- RLS scope runs as also has no DELETE on audit_log (0272). The runtime login cannot delete a ledger row under any
-- reason.

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
                    'credential_request']) THEN
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
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['audit_chain', 'audit_verify', 'audit_subject', 'migration',
                                                        'system_task', 'audit_retention'])
);
--> statement-breakpoint
DO $do$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY audit_log_delete ON audit_log FOR DELETE TO %I USING ('
    '(SELECT regulait_rls_system_reason()) = ANY (ARRAY[''audit_retention'', ''migration'']))',
    (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = 'public.audit_log'::regclass));
END
$do$;
