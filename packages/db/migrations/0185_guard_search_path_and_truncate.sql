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
--    plus `audit_log`, whose append-only rule is enforced by the hash chain and its anchors rather than a row
--    trigger, and `audit_anchors`. Row-level DELETE paths that exist on purpose (the expiry sweeps of `issued_tokens` and
--    `replay_claims`, deleting a closed incident, test fixtures deleting their own audit rows) are unaffected.
--    The lists were generated from pg_catalog on a database migrated to 0183 and are written out statically here.
-- 1. pinned search_path: every public plpgsql/sql function through 0183 (33 here, plus
--    regulait_refuse_truncate below). 0182/0183 already pin their own; repeating it is a harmless no-op.
ALTER FUNCTION public.advance_governance_policy_epoch() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.config_versions_retire_on_subject_delete() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.imported_cost_lines_unattribute() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_ai_bom_serial(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_ai_bom_snapshot_version_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_audit_anchor_request_facts_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_auditor_grant_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_json_safe(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_prune_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_prune_record_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_rendering_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_bom_retention_hold_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_canonical_json(jsonb) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_capture_status_consistent() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_decision_bom_version_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_decision_fact_addendum_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_decision_fact_addendum_signature_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_decision_facts_marker_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_decision_receipt_version_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_delegation_allocation_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_delegation_grant_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_execution_profile_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_executor_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_identity_signing_key_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_issued_token_guard() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.regulait_receipt_payload_version_guard() SET search_path = pg_catalog, public, pg_temp;
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
-- 0182 and 0183 merged first and already create this function; the body here is byte-identical to theirs, so
-- CREATE OR REPLACE is a no-op on a database that ran them and a create on one that did not.
CREATE OR REPLACE FUNCTION public.regulait_refuse_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION '%: TRUNCATE refused (append-only)', TG_TABLE_NAME; END $$;
--> statement-breakpoint
-- 34 tables. DROP IF EXISTS first: 0182/0183 already created some of these, so this is idempotent.
DROP TRIGGER IF EXISTS "ai_bom_snapshots_no_truncate" ON public."ai_bom_snapshots";
--> statement-breakpoint
CREATE TRIGGER "ai_bom_snapshots_no_truncate" BEFORE TRUNCATE ON public."ai_bom_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_incident_events_no_truncate" ON public."ai_incident_events";
--> statement-breakpoint
CREATE TRIGGER "ai_incident_events_no_truncate" BEFORE TRUNCATE ON public."ai_incident_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_incident_notifications_no_truncate" ON public."ai_incident_notifications";
--> statement-breakpoint
CREATE TRIGGER "ai_incident_notifications_no_truncate" BEFORE TRUNCATE ON public."ai_incident_notifications"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_incidents_no_truncate" ON public."ai_incidents";
--> statement-breakpoint
CREATE TRIGGER "ai_incidents_no_truncate" BEFORE TRUNCATE ON public."ai_incidents"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "approval_decisions_no_truncate" ON public."approval_decisions";
--> statement-breakpoint
CREATE TRIGGER "approval_decisions_no_truncate" BEFORE TRUNCATE ON public."approval_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_anchors_no_truncate" ON public."audit_anchors";
--> statement-breakpoint
CREATE TRIGGER "audit_anchors_no_truncate" BEFORE TRUNCATE ON public."audit_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_chain_versions_no_truncate" ON public."audit_chain_versions";
--> statement-breakpoint
CREATE TRIGGER "audit_chain_versions_no_truncate" BEFORE TRUNCATE ON public."audit_chain_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON public."audit_log";
--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON public."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bom_auditor_grants_no_truncate" ON public."bom_auditor_grants";
--> statement-breakpoint
CREATE TRIGGER "bom_auditor_grants_no_truncate" BEFORE TRUNCATE ON public."bom_auditor_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bom_renderings_no_truncate" ON public."bom_renderings";
--> statement-breakpoint
CREATE TRIGGER "bom_renderings_no_truncate" BEFORE TRUNCATE ON public."bom_renderings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bom_retention_holds_no_truncate" ON public."bom_retention_holds";
--> statement-breakpoint
CREATE TRIGGER "bom_retention_holds_no_truncate" BEFORE TRUNCATE ON public."bom_retention_holds"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bom_retention_prunes_no_truncate" ON public."bom_retention_prunes";
--> statement-breakpoint
CREATE TRIGGER "bom_retention_prunes_no_truncate" BEFORE TRUNCATE ON public."bom_retention_prunes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_boms_no_truncate" ON public."decision_boms";
--> statement-breakpoint
CREATE TRIGGER "decision_boms_no_truncate" BEFORE TRUNCATE ON public."decision_boms"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_capture_status_no_truncate" ON public."decision_capture_status";
--> statement-breakpoint
CREATE TRIGGER "decision_capture_status_no_truncate" BEFORE TRUNCATE ON public."decision_capture_status"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_fact_addenda_no_truncate" ON public."decision_fact_addenda";
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addenda_no_truncate" BEFORE TRUNCATE ON public."decision_fact_addenda"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_fact_addendum_signatures_no_truncate" ON public."decision_fact_addendum_signatures";
--> statement-breakpoint
CREATE TRIGGER "decision_fact_addendum_signatures_no_truncate" BEFORE TRUNCATE ON public."decision_fact_addendum_signatures"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_facts_no_truncate" ON public."decision_facts";
--> statement-breakpoint
CREATE TRIGGER "decision_facts_no_truncate" BEFORE TRUNCATE ON public."decision_facts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "decision_receipts_no_truncate" ON public."decision_receipts";
--> statement-breakpoint
CREATE TRIGGER "decision_receipts_no_truncate" BEFORE TRUNCATE ON public."decision_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "delegation_allocations_no_truncate" ON public."delegation_allocations";
--> statement-breakpoint
CREATE TRIGGER "delegation_allocations_no_truncate" BEFORE TRUNCATE ON public."delegation_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "delegation_charges_no_truncate" ON public."delegation_charges";
--> statement-breakpoint
CREATE TRIGGER "delegation_charges_no_truncate" BEFORE TRUNCATE ON public."delegation_charges"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "delegation_grants_no_truncate" ON public."delegation_grants";
--> statement-breakpoint
CREATE TRIGGER "delegation_grants_no_truncate" BEFORE TRUNCATE ON public."delegation_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_placements_no_truncate" ON public."execution_placements";
--> statement-breakpoint
CREATE TRIGGER "execution_placements_no_truncate" BEFORE TRUNCATE ON public."execution_placements"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_profiles_no_truncate" ON public."execution_profiles";
--> statement-breakpoint
CREATE TRIGGER "execution_profiles_no_truncate" BEFORE TRUNCATE ON public."execution_profiles"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "executor_attestations_no_truncate" ON public."executor_attestations";
--> statement-breakpoint
CREATE TRIGGER "executor_attestations_no_truncate" BEFORE TRUNCATE ON public."executor_attestations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "executors_no_truncate" ON public."executors";
--> statement-breakpoint
CREATE TRIGGER "executors_no_truncate" BEFORE TRUNCATE ON public."executors"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "governance_review_policy_versions_no_truncate" ON public."governance_review_policy_versions";
--> statement-breakpoint
CREATE TRIGGER "governance_review_policy_versions_no_truncate" BEFORE TRUNCATE ON public."governance_review_policy_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "identity_signing_keys_no_truncate" ON public."identity_signing_keys";
--> statement-breakpoint
CREATE TRIGGER "identity_signing_keys_no_truncate" BEFORE TRUNCATE ON public."identity_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "issued_tokens_no_truncate" ON public."issued_tokens";
--> statement-breakpoint
CREATE TRIGGER "issued_tokens_no_truncate" BEFORE TRUNCATE ON public."issued_tokens"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "receipt_payload_versions_no_truncate" ON public."receipt_payload_versions";
--> statement-breakpoint
CREATE TRIGGER "receipt_payload_versions_no_truncate" BEFORE TRUNCATE ON public."receipt_payload_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "receipt_signing_keys_no_truncate" ON public."receipt_signing_keys";
--> statement-breakpoint
CREATE TRIGGER "receipt_signing_keys_no_truncate" BEFORE TRUNCATE ON public."receipt_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "replay_claims_no_truncate" ON public."replay_claims";
--> statement-breakpoint
CREATE TRIGGER "replay_claims_no_truncate" BEFORE TRUNCATE ON public."replay_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "use_case_decision_records_no_truncate" ON public."use_case_decision_records";
--> statement-breakpoint
CREATE TRIGGER "use_case_decision_records_no_truncate" BEFORE TRUNCATE ON public."use_case_decision_records"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workload_credentials_no_truncate" ON public."workload_credentials";
--> statement-breakpoint
CREATE TRIGGER "workload_credentials_no_truncate" BEFORE TRUNCATE ON public."workload_credentials"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workload_identities_no_truncate" ON public."workload_identities";
--> statement-breakpoint
CREATE TRIGGER "workload_identities_no_truncate" BEFORE TRUNCATE ON public."workload_identities"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();

--> statement-breakpoint
-- 3. I1R-01: `execution_profiles_body_check` (0183) compared `->>` extractions, which yield NULL for a missing or
--    JSON-null key, and a CHECK that evaluates to NULL passes, so a body of `{}` or `{"schema":null,...}` was stored.
--    The same predicate wrapped in COALESCE(..., false): an unknown result is now a refusal. Same name; the shipped
--    rows 0183 seeded are re-validated by the ADD.
ALTER TABLE "execution_profiles"
  DROP CONSTRAINT "execution_profiles_body_check",
  ADD CONSTRAINT "execution_profiles_body_check" CHECK (COALESCE(
    length("body") <= 65536
    AND jsonb_typeof("body"::jsonb) = 'object'
    AND ("body"::jsonb ->> 'schema') = 'regulait.execution-profile.v1'
    AND ("body"::jsonb ->> 'name') = "name"
    AND ("body"::jsonb ->> 'minClass') = "min_class",
    false
  ));
