-- Migration 0094 (ADR-0092) — the `from_recommendations` certification-
-- campaign scope (gap L24, docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
--
-- Access recommendations are computed at READ TIME (no table, no stored
-- recommendation rows — the ADR-0082 discipline), so the ONLY schema change
-- L24 needs is widening the ADR-0090 campaign-scope vocabulary: a campaign
-- may now be scoped to "the grants the named recommendation rules flag at
-- open". The scope VALUE carries the comma-separated rule ids; the snapshot
-- is computed at open (never stored), and the existing scope_value pairing
-- check already fits (non-'all' scope = non-null value).
--
-- This is the recommend → review → human-decides → revoke-is-real action
-- path: recommendations feed campaigns; they never execute anything.

ALTER TABLE "grant_certification_campaigns"
  DROP CONSTRAINT "grant_cert_campaigns_scope_kind_check";
ALTER TABLE "grant_certification_campaigns"
  ADD CONSTRAINT "grant_cert_campaigns_scope_kind_check"
  CHECK ("scope_kind" IN ('all', 'agent_lifecycle', 'agent_owner', 'user', 'from_recommendations'));
