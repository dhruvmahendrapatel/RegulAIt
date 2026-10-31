-- ADR-0213 (backlog P6) — the governed vendor-questionnaire drafter.
--
--   * org_settings.vendor_draft_assist_enabled: the default-off switch. FALSE
--     (the strict default) = the vendor questionnaire is filled by hand only;
--     turning it on is an audited, step-up admin relaxation (the settings_relax
--     hook in org-settings.ts reads the strictness registry).
--   * model_policy_rules.feature gains 'vendor_draft', so an admin can restrict
--     which models may draft vendor answers, per data class.
--
-- Nothing else is stored: a draft is returned to the person and written
-- nowhere; the questionnaire artifact and the attestations keep their
-- existing, human-only write paths.
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "vendor_draft_assist_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "model_policy_rules" DROP CONSTRAINT IF EXISTS "model_policy_rules_feature_ck";
--> statement-breakpoint
ALTER TABLE "model_policy_rules" ADD CONSTRAINT "model_policy_rules_feature_ck"
  CHECK ("feature" IN ('chat', 'builder', 'copilot', 'intake_assist', 'vendor_draft', 'evals', 'orchestration', 'compat', 'playground'));
