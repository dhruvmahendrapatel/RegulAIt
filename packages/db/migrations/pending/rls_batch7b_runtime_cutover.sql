-- ADR-0234 batch 7b (PENDING S7): the runtime login cut-over.
--
-- From this batch requests are served on a login that is a member of regulait_app and is not a superuser, BYPASSRLS
-- or the table owner (the gateway creates it at first boot, or an operator provides it). The owner (migrator) login
-- keeps the migrations and the one job that deletes from the ledger: the audit retention prune.
--
-- FORCE ROW LEVEL SECURITY binds the owner too, and audit_log had no DELETE policy, so an owner that is not a
-- superuser could not prune. A closed, owner-only reason is added for it:
--   audit_retention  the retention prune on the owner connection: audit_log (read, delete). The app role every RLS
--                    scope runs as has no DELETE on audit_log (0272), and the gateway never offers this reason to a
--                    caller, so it cannot be used to remove ledger rows from a request path.

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
                    'system_task', 'public_ingest', 'bootstrap_admin', 'audit_retention']) THEN
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
CREATE POLICY audit_log_delete ON audit_log FOR DELETE USING (
  (SELECT regulait_rls_system_reason()) = ANY (ARRAY['audit_retention', 'migration'])
);
