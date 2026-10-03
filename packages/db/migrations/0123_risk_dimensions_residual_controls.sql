-- ADR-0147 — risk categories for the bias and safety trust dimensions,
-- a DECLARED residual position, and mitigating-control links.
--
-- 1. Two new categories. `bias_fairness` is evidenced by model cards'
--    DOCUMENTED fairness assessments (an attestation, labelled as one);
--    `unsafe_output` by output-safety guardrail configuration and blocks.
ALTER TABLE "ai_risks" DROP CONSTRAINT IF EXISTS "ai_risks_category_check";
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_category_check"
  CHECK ("category" IN ('tool_misuse', 'scope_drift', 'prompt_injection', 'data_leakage_pii',
                        'over_permissioning', 'budget_overrun', 'hallucination', 'shadow_ai',
                        'third_party_ai', 'bias_fairness', 'unsafe_output'));
--> statement-breakpoint
-- 2. The residual position: the same declared three-level scale as the
--    inherent one, never arithmetic. Both or neither.
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "residual_likelihood" text;
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "residual_impact" text;
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_residual_levels_check"
  CHECK (("residual_likelihood" IS NULL OR "residual_likelihood" IN ('low', 'medium', 'high'))
     AND ("residual_impact" IS NULL OR "residual_impact" IN ('low', 'medium', 'high')));
--> statement-breakpoint
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_residual_pair_check"
  CHECK (("residual_likelihood" IS NULL) = ("residual_impact" IS NULL));
--> statement-breakpoint
-- 3. Mitigating controls, by the pack control's stable ref. The gateway
--    validates the ref against the seeded packs; a link is a claim that the
--    control mitigates THIS risk, recorded with who made it.
CREATE TABLE IF NOT EXISTS "ai_risk_controls" (
  "risk_id" uuid NOT NULL REFERENCES "ai_risks"("id") ON DELETE CASCADE,
  "control_ref" text NOT NULL,
  "linked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_risk_controls_pk" PRIMARY KEY ("risk_id", "control_ref"),
  CONSTRAINT "ai_risk_controls_ref_check" CHECK (length(btrim("control_ref")) > 2)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_risk_controls_ref_idx" ON "ai_risk_controls" ("control_ref");
