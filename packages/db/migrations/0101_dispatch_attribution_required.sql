-- Migration 0101 (batch B6b) — ONE ENFORCEMENT OPT-IN, DEFAULT-OFF.
--
--   * dispatch_attribution_required (ADR-0080 amendment). B3a armed the
--     use-case dispatch gate, and recorded the hole it could not close from
--     inside itself: "nothing mandates that a dispatch be attributed to a
--     linked project at all — attribution stays the pillar-5 opt-in, so the
--     gate cannot see a call naming no project." This knob is that mandate.
--     false (default) = today, byte-identical: an unattributed governed
--     dispatch runs and lands in the explicit "Unattributed" cost bucket.
--     true = a governed dispatch naming NO projectId is refused 409
--     `attribution_required`, audited, before any provider work.
--
--     It is INDEPENDENT of use_case_gate_mode by construction: this gate acts
--     only where projectId IS NULL, the use-case gate only where it is NOT.
--     The two never see the same dispatch, so the four combinations compose
--     with no precedence rule to remember.
--
--     It is ALSO distinct from interception_settings.require_project_attribution
--     (ADR-0020, the compat shims' own 400 at their own edge) and from
--     require_mcp_attribution (ADR-0024 O11, the MCP proxy's). Those guard
--     surfaces this one cannot reach; this one guards the NATIVE governed
--     dispatch neither of them touches.
--
-- No data movement, no backfill, no new table. Flipping the knob back restores
-- the prior behaviour with every row intact.

ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "dispatch_attribution_required" boolean NOT NULL DEFAULT false;
