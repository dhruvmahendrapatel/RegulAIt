-- Database guard hardening: a pinned search_path on every function, and TRUNCATE refused on every append-only table.
-- Hand-authored (never drizzle-kit generate). Open source first (ADR-0176): no library applies; this is Postgres DDL.
-- Secure by default (ADR-0180): nothing here can be relaxed by a setting; a later migration that needs a TRUNCATE
-- must drop the trigger in the open, in review.
--
-- 1. SEARCH_PATH. Until now no function in `public` pinned its search_path, and the guards name tables unqualified
--    (`"delegation_grants"`, `"config_versions"`, `governance_policy_epoch`, and `format('%I', TG_ARGV[1])` in
--    `regulait_refuse_mutation`). Unqualified relation names resolve through the CALLER's search_path, which searches
--    `pg_temp` first unless it is named later. A session holding only the default TEMP privilege could therefore
--    `CREATE TEMP TABLE ai_incidents (id uuid)` and make `regulait_refuse_mutation` believe an evidence row's parent
--    incident was gone, so a DELETE of an append-only `ai_incident_events` row passed (proven on a database migrated to
--    0181; see apps/gateway/src/zz-dbguard-0185.test.ts). The same shadowing fakes a parent grant for
--    `regulait_delegation_grant_guard`, skips the policy-epoch bump, and skips the config-version retirement.
--    `pg_catalog, public, pg_temp` puts pg_temp LAST, so every unqualified name resolves to `public` first. Function
--    bodies are unchanged. `CREATE OR REPLACE FUNCTION` resets this setting, so any later migration that redefines one
--    of these functions must repeat the SET clause; the 0185 test fails CI when a public plpgsql/sql function lacks it.
--
-- 2. TRUNCATE. Append-only tables were protected by row-level triggers only, and TRUNCATE fires no row trigger. Every
--    table with a BEFORE ROW trigger that refuses an UPDATE or DELETE now also refuses TRUNCATE (statement trigger),
--    plus `audit_log` and `audit_anchors`, whose append-only rule is enforced by the hash chain and its anchors rather
--    than a row trigger. Row-level DELETE paths that exist on purpose (the expiry sweeps of `issued_tokens` and
--    `replay_claims`, deleting a closed incident, test fixtures deleting their own audit rows) are unaffected.
--    The list was generated from pg_trigger on a database migrated to 0181 and is written out statically here.
-- 1. pinned search_path (15 functions: every function in public at 0181)
ALTER FUNCTION public.advance_governance_policy_epoch() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.config_versions_retire_on_subject_delete() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.imported_cost_lines_unattribute() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_canonical_json(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_delegation_allocation_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_delegation_grant_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_identity_signing_key_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_issued_token_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_refuse_mutation() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_refuse_open_incident_delete() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_replay_claim_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_stamp_secret_set() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_text_array_matches(text[], text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_workload_credential_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_workload_identity_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
-- 2. the TRUNCATE refusal
CREATE FUNCTION public.regulait_refuse_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE refused', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'records here are evidence; TRUNCATE bypasses the row guards (migration 0185)';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ai_incident_events_no_truncate" BEFORE TRUNCATE ON public."ai_incident_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "ai_incident_notifications_no_truncate" BEFORE TRUNCATE ON public."ai_incident_notifications"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "ai_incidents_no_truncate" BEFORE TRUNCATE ON public."ai_incidents"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "approval_decisions_no_truncate" BEFORE TRUNCATE ON public."approval_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "audit_chain_versions_no_truncate" BEFORE TRUNCATE ON public."audit_chain_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "decision_receipts_no_truncate" BEFORE TRUNCATE ON public."decision_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "delegation_allocations_no_truncate" BEFORE TRUNCATE ON public."delegation_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "delegation_charges_no_truncate" BEFORE TRUNCATE ON public."delegation_charges"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "delegation_grants_no_truncate" BEFORE TRUNCATE ON public."delegation_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "governance_review_policy_versions_no_truncate" BEFORE TRUNCATE ON public."governance_review_policy_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "identity_signing_keys_no_truncate" BEFORE TRUNCATE ON public."identity_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "issued_tokens_no_truncate" BEFORE TRUNCATE ON public."issued_tokens"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "receipt_signing_keys_no_truncate" BEFORE TRUNCATE ON public."receipt_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "replay_claims_no_truncate" BEFORE TRUNCATE ON public."replay_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "use_case_decision_records_no_truncate" BEFORE TRUNCATE ON public."use_case_decision_records"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "workload_credentials_no_truncate" BEFORE TRUNCATE ON public."workload_credentials"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "workload_identities_no_truncate" BEFORE TRUNCATE ON public."workload_identities"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "audit_anchors_no_truncate" BEFORE TRUNCATE ON public."audit_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON public."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
