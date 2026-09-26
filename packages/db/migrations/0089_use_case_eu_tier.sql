-- Migration 0089 (ADR-0085) — EU AI ACT RISK-TIER SCREENING ON THE USE-CASE
-- INTAKE (gap L10, docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md).
--
-- Three nullable columns on ai_use_cases, NO new table: the ADR-0080 intake
-- questionnaire gains a structured EU-AI-Act screening section, and the
-- gateway computes a tier from those answers SERVER-SIDE with the frozen
-- shared rule set (EU_AI_ACT_RULESET_V1, hash-pinned in the shared suite)
-- whenever the questionnaire artifact lands. Re-submission recomputes.
--
-- THE RULES THIS SCHEMA STATES (enforced in the gateway):
--
--   * The tier is COMPUTED, NEVER ACCEPTED. No endpoint writes these columns
--     from a payload: a `tier` key inside the answers block is refused by the
--     parser, and a PATCH naming `euAiActTier` is refused by name — the
--     answers are the only input.
--   * The tier is a SCREENING result, not legal advice — every read of it
--     carries the shared disclaimer as a field, and the stored
--     `eu_ai_act_ruleset_version` says exactly which frozen encoding produced
--     it, forever (a rule-set revision is a NEW version, never an edit).
--   * The tier INFORMS the human sign-off on the one approvals queue.
--     NOTHING AUTO-BLOCKS ON IT — approval already gates nothing (ADR-0080's
--     honest limit), and a tier that silently blocked would overclaim
--     enforcement this platform does not do. A `prohibited` tier renders as
--     an unmissable refusal-shaped banner for the human who decides.
--
-- All three columns are set together, or all three are NULL (= the submitted
-- questionnaire carried no valid answers block — "not screened", never a
-- guessed tier).

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD COLUMN "eu_ai_act_tier" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD COLUMN "eu_ai_act_reasons" jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD COLUMN "eu_ai_act_ruleset_version" integer;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

ALTER TABLE "ai_use_cases" DROP CONSTRAINT IF EXISTS "ai_use_cases_eu_tier_check";
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_eu_tier_check"
  CHECK ("eu_ai_act_tier" IS NULL
         OR "eu_ai_act_tier" IN ('prohibited', 'high', 'limited', 'minimal'));

ALTER TABLE "ai_use_cases" DROP CONSTRAINT IF EXISTS "ai_use_cases_eu_tier_consistency_check";
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_eu_tier_consistency_check"
  CHECK (("eu_ai_act_tier" IS NULL) = ("eu_ai_act_ruleset_version" IS NULL)
     AND ("eu_ai_act_tier" IS NULL) = ("eu_ai_act_reasons" IS NULL));

CREATE INDEX IF NOT EXISTS "ai_use_cases_eu_tier_idx" ON "ai_use_cases" ("eu_ai_act_tier");
