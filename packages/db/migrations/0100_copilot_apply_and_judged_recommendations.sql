-- Migration 0100 (L6) — THE COPILOT'S APPLY LEDGER, AND THE OPT-IN JUDGED
-- ANNOTATION KNOB. Both default to today's behaviour exactly.
--
--   * copilot_proposals.applied_at / applied_by_user_id / applied_result.
--     ADR-0056's amendment named "an approved proposal is not applied by
--     anything" as its largest structural gap. L6b closes it with a
--     CONSENT-GATED applier: an APPROVED proposal (through the one existing
--     approvals queue) can be applied by an admin, executing through the same
--     public choke points an admin would use by hand (`applyRuleEdit` for a
--     rule edit; the one-per-kind removal in grant-revocation.ts for a grant).
--     These three columns are the ledger of that act: WHEN, by WHOM, and
--     exactly WHAT the choke point reported back. NULL applied_at (every
--     existing row, and every new one) = not applied, which is the pre-L6
--     state of the world for all of them.
--
--     `applied_at` also IS the idempotency gate: the applier refuses a second
--     apply by name rather than re-executing a mutation.
--
--   * org_settings.recommendation_judge_enabled / _agent_id (ADR-0092
--     amendment, L24's model-judged half). Default FALSE = the deterministic
--     report is byte-identical to what ADR-0092 shipped, which is the point:
--     the judged layer is an opt-in ANNOTATION over findings the deterministic
--     rules already made, never a new source of findings. When the knob is on
--     and no judge agent is named or none is dispatchable, the report is
--     returned UNCHANGED with `judged: unavailable` — the ADR-0067 typed
--     refusal, not a silent downgrade.
--
-- No data movement, no backfill, no new table. Reversing either knob restores
-- the prior behaviour with every row intact.

ALTER TABLE "copilot_proposals"
  ADD COLUMN IF NOT EXISTS "applied_at" timestamptz;
ALTER TABLE "copilot_proposals"
  ADD COLUMN IF NOT EXISTS "applied_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "copilot_proposals"
  ADD COLUMN IF NOT EXISTS "applied_result" jsonb;

ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "recommendation_judge_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "recommendation_judge_agent_id" uuid;
