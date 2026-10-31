-- ADR-0216 (P15): the risk register's supply-chain category, and the link from a supply-chain risk to the model
-- artifact that opened it. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `supply_chain` joins the category vocabulary (kept in lockstep with @regulait/shared AI_RISK_CATEGORIES).
-- 2. `model_artifact_id`: the artifact whose failing supply-chain check opened the risk. At most one supply-chain
--    risk that is not closed per artifact, so a repeated block never opens a second entry.
ALTER TABLE "ai_risks" DROP CONSTRAINT IF EXISTS "ai_risks_category_check";
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_category_check"
  CHECK ("category" IN ('tool_misuse', 'scope_drift', 'prompt_injection', 'data_leakage_pii',
                        'over_permissioning', 'budget_overrun', 'hallucination', 'shadow_ai',
                        'third_party_ai', 'bias_fairness', 'unsafe_output', 'supply_chain'));
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "model_artifact_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_model_artifact_id_fkey"
    FOREIGN KEY ("model_artifact_id") REFERENCES "model_artifacts"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_model_artifact_category_check"
    CHECK ("model_artifact_id" IS NULL OR "category" = 'supply_chain');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_risks_supply_chain_artifact_open_unique"
  ON "ai_risks" ("model_artifact_id") WHERE "model_artifact_id" IS NOT NULL AND "status" <> 'closed';
