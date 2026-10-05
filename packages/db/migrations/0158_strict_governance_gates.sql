-- ADR-0181 (strict defaults), agent SB2: the governance gates.
--
-- Every setting below now defaults to its strict value, and, as for a first
-- load, the existing singleton rows are moved to that value too (the product
-- is not live; nothing is grandfathered). An admin may relax each one on its
-- existing audited write route, and the audit row records old -> new:
--
--   org_settings.use_case_gate_mode             off       -> enforce   PUT /v1/org/settings
--   org_settings.dispatch_attribution_required  false     -> true      PUT /v1/org/settings
--   org_settings.mrm_enforced                   false     -> true      POST /v1/mrm/enforcement
--   org_settings.mrm_staleness_recert_enabled   false     -> true      POST /v1/mrm/enforcement
--   interception_settings.require_project_attribution  false -> true   PUT /v1/interception/settings
--   interception_settings.require_mcp_attribution      false -> true   PUT /v1/interception/settings
--   interception_settings.key_custody_enforced         false -> true   PUT /v1/interception/settings
--   interception_settings.enforcement_posture   voluntary -> managed   PUT /v1/interception/settings
--   policy_simulation_settings.require_preview_before_activate  false -> true
--                                                                      PUT /v1/policy-simulations/settings
--   builder_agent_tools.requires_approval       false     -> true      PUT /v1/builder/agents/:id/tools
--   projects.alert_threshold_pct                100       -> 80        PATCH /v1/projects/:id
--
-- Rows: the singletons are set outright. A project still on the old default
-- (100) moves to 80; a project an admin set to any other value keeps it.
-- Builder tools all become ask-first; an owner turns it off per tool.

ALTER TABLE "org_settings" ALTER COLUMN "use_case_gate_mode" SET DEFAULT 'enforce';
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "dispatch_attribution_required" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "mrm_enforced" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "mrm_staleness_recert_enabled" SET DEFAULT true;
--> statement-breakpoint
UPDATE "org_settings" SET "use_case_gate_mode" = 'enforce', "dispatch_attribution_required" = true, "mrm_enforced" = true, "mrm_staleness_recert_enabled" = true;
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "require_project_attribution" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "require_mcp_attribution" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "key_custody_enforced" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "interception_settings" ALTER COLUMN "enforcement_posture" SET DEFAULT 'managed';
--> statement-breakpoint
UPDATE "interception_settings" SET "require_project_attribution" = true, "require_mcp_attribution" = true, "key_custody_enforced" = true, "enforcement_posture" = 'managed';
--> statement-breakpoint
ALTER TABLE "policy_simulation_settings" ALTER COLUMN "require_preview_before_activate" SET DEFAULT true;
--> statement-breakpoint
UPDATE "policy_simulation_settings" SET "require_preview_before_activate" = true;
--> statement-breakpoint
ALTER TABLE "builder_agent_tools" ALTER COLUMN "requires_approval" SET DEFAULT true;
--> statement-breakpoint
UPDATE "builder_agent_tools" SET "requires_approval" = true;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "alert_threshold_pct" SET DEFAULT 80;
--> statement-breakpoint
UPDATE "projects" SET "alert_threshold_pct" = 80 WHERE "alert_threshold_pct" = 100;
