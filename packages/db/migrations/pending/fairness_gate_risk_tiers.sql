-- ADR-0346 decision 9 (owner 2026-11-21): the ADR-0085 risk tiers whose model cards the fairness promotion gate always
-- covers. Secure by default (ADR-0180): the high-risk tiers (prohibited, high) are on; limited and minimal are off. An
-- admin may turn a tier off (a stepped-up, audited settings relaxation). Hand-authored, additive; org_settings already
-- carries its RLS.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_gate_tier_prohibited" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_gate_tier_high" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_gate_tier_limited" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "fairness_gate_tier_minimal" boolean DEFAULT false NOT NULL;
