-- ADR-0181 (strict defaults, batch SB1) — guardrails, data handling and runtime.
--
-- Every setting below moves to its strict value. An admin may relax each one
-- through its existing audited write route. As for a first load, existing
-- singleton rows are moved to the strict value too.
--
-- guardrail_configs        prompt_injection / jailbreak default to 'block',
--                          toxicity / semantic_dlp to 'warn' (was 'log' for
--                          all four). The org-scope row is RAISED to at least
--                          these values; per-agent / per-connector overrides
--                          are deliberate per-object admin choices and stay.
-- compliance_profiles      pii_mode 'log' -> 'block', mcp_default_mode
--                          'read_write' -> 'read_only'. Only UNVERSIONED rows
--                          are moved: a versioned profile resolves through
--                          config_versions (ADR-0074), and a raw row write
--                          would change nothing that is enforced while
--                          bypassing the version history. A fresh install has
--                          no profiles at all.
-- interception_settings    streaming_on_block_mode 'suppress' -> 'reject',
--                          strict_field_rejection false -> true.
-- org_settings             default_pii_mode 'none' -> 'block',
--                          semantic_cache_policy 'opt_in' -> 'off',
--                          compaction_failure_mode 'fail_open' -> 'fail_closed',
--                          env_key_fallback_enabled true -> false,
--                          custom_model_providers_enabled true -> false,
--                          llm_training_enabled true -> false,
--                          tracing_capture_content true -> false.

ALTER TABLE "guardrail_configs" ALTER COLUMN "prompt_injection_mode" SET DEFAULT 'block';
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ALTER COLUMN "jailbreak_mode" SET DEFAULT 'block';
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ALTER COLUMN "toxicity_mode" SET DEFAULT 'warn';
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ALTER COLUMN "semantic_dlp_mode" SET DEFAULT 'warn';
--> statement-breakpoint
UPDATE "guardrail_configs" SET
  "prompt_injection_mode" = 'block',
  "jailbreak_mode" = 'block',
  "toxicity_mode" = CASE WHEN "toxicity_mode" IN ('off', 'log') THEN 'warn' ELSE "toxicity_mode" END,
  "semantic_dlp_mode" = CASE WHEN "semantic_dlp_mode" IN ('off', 'log') THEN 'warn' ELSE "semantic_dlp_mode" END,
  "updated_at" = now()
WHERE "scope" = 'org';
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ALTER COLUMN "pii_mode" SET DEFAULT 'block';
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ALTER COLUMN "mcp_default_mode" SET DEFAULT 'read_only';
--> statement-breakpoint
UPDATE "compliance_profiles" p SET "pii_mode" = 'block', "mcp_default_mode" = 'read_only'
WHERE NOT EXISTS (
  SELECT 1 FROM "config_versions" v
  WHERE v."artifact_type" = 'compliance_profile' AND v."artifact_id" = p."id"
);
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "streaming_on_block_mode" SET DEFAULT 'reject';
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "strict_field_rejection" SET DEFAULT true;
--> statement-breakpoint
UPDATE "interception_settings" SET "streaming_on_block_mode" = 'reject', "strict_field_rejection" = true, "updated_at" = now();
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "default_pii_mode" SET DEFAULT 'block';
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "semantic_cache_policy" SET DEFAULT 'off';
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "compaction_failure_mode" SET DEFAULT 'fail_closed';
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "env_key_fallback_enabled" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "custom_model_providers_enabled" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "llm_training_enabled" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "tracing_capture_content" SET DEFAULT false;
--> statement-breakpoint
UPDATE "org_settings" SET
  "default_pii_mode" = 'block',
  "semantic_cache_policy" = 'off',
  "compaction_failure_mode" = 'fail_closed',
  "env_key_fallback_enabled" = false,
  "custom_model_providers_enabled" = false,
  "llm_training_enabled" = false,
  "tracing_capture_content" = false,
  "updated_at" = now();
