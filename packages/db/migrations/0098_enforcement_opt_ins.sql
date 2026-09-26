-- Migration 0098 (batch B3) — THREE ENFORCEMENT OPT-INS, ALL DEFAULT-OFF.
--
-- Each column below arms a gate that already had its facts recorded but
-- deliberately gated nothing, and each defaults to the shipped behaviour so
-- an untouched deployment is byte-identical:
--
--   * use_case_gate_mode (ADR-0080 amendment). ADR-0080's honest limit said
--     "approval registers intent; it does not yet gate dispatch". This knob
--     closes that named follow-up as an ORG OPT-IN: 'off' (default) = today,
--     'warn' records the refusal-shaped fact without blocking, 'enforce'
--     refuses a governed dispatch attributed to a project that is LINKED to
--     use cases (ai_use_cases.project_id — the only join the schema honestly
--     holds; an unlinked project is untouched in every mode) unless at least
--     one linked use case is approved.
--
--   * mrm_staleness_recert_enabled / _threshold (ADR-0086 §3's named
--     follow-up, landing in ADR-0045's gate anatomy). ADR-0086 counts ledger
--     drift since certification and gates nothing; these arm the SAME
--     ADR-0045 dispatch gate to treat a certified card whose drift count has
--     reached the threshold as requiring recertification — the same 409 path
--     the expiry gate uses, extended, never forked. Only meaningful while
--     mrm_enforced is on (the knob deepens the one gate; it creates no gate
--     of its own).
--
-- No data movement, no backfill, no new table. Reversing any knob restores
-- the prior behaviour with every registry row intact.

ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "use_case_gate_mode" text NOT NULL DEFAULT 'off';
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "mrm_staleness_recert_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "mrm_staleness_recert_threshold" integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE "org_settings"
    ADD CONSTRAINT "org_settings_use_case_gate_mode_check"
    CHECK ("use_case_gate_mode" IN ('off', 'warn', 'enforce'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "org_settings"
    ADD CONSTRAINT "org_settings_mrm_staleness_recert_threshold_check"
    CHECK ("mrm_staleness_recert_threshold" >= 1 AND "mrm_staleness_recert_threshold" <= 100000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
