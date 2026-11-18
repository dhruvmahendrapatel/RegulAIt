-- ADR-0345 §9 (lane E26; owner 2026-11-17, gap audit C5): geography as a factor in risk tiering. The jurisdictions,
-- the obligations each brings into the risk -> control -> proof register, and the jurisdictions a use case is deployed
-- or used in are DATA: seeded here, admin-editable. The seeded obligations cite only ADR-0158 regulatory feed entries,
-- which carry a primary source and a verified date; the mapping routes evidence and is not a legal determination.
CREATE TABLE IF NOT EXISTS "jurisdictions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_code" text REFERENCES "jurisdictions"("code") ON DELETE RESTRICT,
  "global" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "jurisdictions_code_uq" UNIQUE ("code"),
  CONSTRAINT "jurisdictions_code_check" CHECK ("code" ~ '^[A-Z][A-Za-z]{1,12}(-[A-Z0-9]{2,4})?$'),
  CONSTRAINT "jurisdictions_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "jurisdictions_parent_check" CHECK ("parent_code" IS NULL OR "parent_code" <> "code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jurisdictions_parent_idx" ON "jurisdictions" ("parent_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jurisdiction_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "jurisdiction_code" text NOT NULL REFERENCES "jurisdictions"("code") ON DELETE CASCADE,
  -- an ADR-0158 regulatory feed key (a versioned code catalogue, so no FK; the gateway refuses an unknown key)
  "regulatory_update_key" text NOT NULL,
  -- an ADR-0345 agent risk key (the code catalogue, so no FK; the CHECK pins the vocabulary)
  "agent_risk_key" text NOT NULL,
  "tier_floor" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "jurisdiction_obligations_update_key_check" CHECK ("regulatory_update_key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "jurisdiction_obligations_risk_check" CHECK ("agent_risk_key" IN ('prompt_injection', 'data_leakage',
    'tool_misuse', 'hallucination', 'access_control_failure', 'autonomous_overreach', 'supply_chain',
    'memory_context_exploit', 'infrastructure_baseline', 'governance_gap')),
  -- tier_floor values must equal EU_AI_ACT_TIERS (@regulait/shared eu-ai-act.ts); a test pins the two together
  CONSTRAINT "jurisdiction_obligations_tier_check" CHECK ("tier_floor" IS NULL OR "tier_floor" IN ('minimal', 'limited', 'high', 'prohibited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jurisdiction_obligations_uq" ON "jurisdiction_obligations" ("jurisdiction_code", "regulatory_update_key", "agent_risk_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_use_case_jurisdictions" (
  "use_case_id" uuid NOT NULL REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "jurisdiction_code" text NOT NULL REFERENCES "jurisdictions"("code") ON DELETE RESTRICT,
  "added_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_use_case_jurisdictions_pk" PRIMARY KEY ("use_case_id", "jurisdiction_code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_use_case_jurisdictions_code_idx" ON "ai_use_case_jurisdictions" ("jurisdiction_code");
--> statement-breakpoint
-- the seed: exactly the jurisdictions the ADR-0158 feed names
INSERT INTO "jurisdictions" ("code", "name", "parent_code", "global") VALUES
  ('EU', 'European Union', NULL, false),
  ('US', 'United States (federal)', NULL, false),
  ('US-CO', 'Colorado', 'US', false),
  ('US-NYC', 'New York City', 'US', false),
  ('International', 'International standards', NULL, true)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
-- each feed entry in force, upcoming or published, mapped to the agent risks whose controls and proofs answer it.
-- No seeded row sets a tier floor: a floor is a legal judgement an admin records (owner question in ADR-0345 §9).
INSERT INTO "jurisdiction_obligations" ("jurisdiction_code", "regulatory_update_key", "agent_risk_key") VALUES
  ('EU', 'eu-ai-act-prohibitions-in-force', 'governance_gap'),
  ('EU', 'eu-ai-act-gpai-in-force', 'supply_chain'),
  ('EU', 'eu-ai-act-gpai-in-force', 'data_leakage'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'prompt_injection'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'data_leakage'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'hallucination'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'autonomous_overreach'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'access_control_failure'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'infrastructure_baseline'),
  ('EU', 'eu-ai-act-high-risk-annex-iii-in-force', 'governance_gap'),
  ('EU', 'eu-ai-act-high-risk-annex-i-in-force', 'governance_gap'),
  ('EU', 'eu-ai-act-transparency-in-force', 'governance_gap'),
  ('EU', 'eu-dora-in-force', 'infrastructure_baseline'),
  ('EU', 'eu-dora-in-force', 'supply_chain'),
  ('US', 'nist-ai-rmf-1-0', 'governance_gap'),
  ('US', 'nist-ai-rmf-genai-profile', 'prompt_injection'),
  ('US', 'nist-ai-rmf-genai-profile', 'data_leakage'),
  ('US', 'nist-ai-rmf-genai-profile', 'hallucination'),
  ('US-CO', 'colorado-ai-act-sb26-189', 'governance_gap'),
  ('US-NYC', 'nyc-local-law-144', 'governance_gap'),
  ('International', 'iso-42001-published', 'governance_gap')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "jurisdictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jurisdictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "jurisdictions_admin" ON "jurisdictions";
--> statement-breakpoint
CREATE POLICY "jurisdictions_admin" ON "jurisdictions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "jurisdiction_obligations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jurisdiction_obligations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "jurisdiction_obligations_admin" ON "jurisdiction_obligations";
--> statement-breakpoint
CREATE POLICY "jurisdiction_obligations_admin" ON "jurisdiction_obligations" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "ai_use_case_jurisdictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_use_case_jurisdictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "ai_use_case_jurisdictions_admin" ON "ai_use_case_jurisdictions";
--> statement-breakpoint
CREATE POLICY "ai_use_case_jurisdictions_admin" ON "ai_use_case_jurisdictions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
